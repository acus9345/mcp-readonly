/**
 * Decide whether an MCP tool is safe to expose in a read-only session.
 *
 * Order of precedence (first match wins):
 *   1. --deny pattern            -> blocked
 *   2. --allow pattern           -> allowed
 *   3. annotations.destructiveHint === true  -> blocked
 *   4. annotations.readOnlyHint === true     -> allowed (unless --distrust-annotations and the name says "write")
 *   5. annotations.readOnlyHint === false    -> blocked
 *   6. name heuristic: any write/exec verb anywhere in the name -> blocked. Otherwise the name is a read candidate
 *      only if its verb (the first word, after known namespace prefixes like git_ or browser_) is a read verb and
 *      it has no opaque word (query, sql, ...) and no unknown second action (scan_and_fix).
 *   7. description: any write verb anywhere -> blocked. It is checked for every tool that gets this far, and it
 *      can only block: a read candidate with a clean description is allowed.
 *   8. otherwise: unclassified -> blocked (fail closed), or allowed with --unknown allow
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
  [k: string]: unknown;
}

export interface ToolInfo {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  [k: string]: unknown;
}

export interface Policy {
  allow: string[];
  deny: string[];
  /** What to do with tools nothing can classify. Default "block". */
  unknown: 'block' | 'allow';
  /** Let a write-sounding name override readOnlyHint: true. Default false. */
  distrustAnnotations: boolean;
}

export const defaultPolicy: Policy = { allow: [], deny: [], unknown: 'block', distrustAnnotations: false };

export type Source = 'deny' | 'allow' | 'annotation' | 'name' | 'description' | 'default';

export interface Verdict {
  allowed: boolean;
  source: Source;
  reason: string;
  /** Non-fatal observations, e.g. an annotation that contradicts the name. */
  warnings: string[];
}

/** Verbs that change state or run code somewhere. Any of them anywhere in the name blocks the tool. */
export const WRITE_WORDS = new Set(
  `create add new insert update upsert edit modify patch set put post write save store upload append prepend replace
  rename move mv copy cp delete del remove rm drop truncate purge clear reset destroy erase wipe kill terminate stop
  start restart reboot shutdown cancel archive unarchive merge push commit publish unpublish deploy release rollback
  revert send email reply comment invite assign unassign approve reject transfer pay charge refund exec execute run
  eval evaluate invoke call apply install uninstall import export sync enable disable grant revoke lock unlock fork
  mkdir touch chmod chown submit schedule reschedule book order buy purchase subscribe unsubscribe like unlike follow
  unfollow star unstar ban unban mute unmute block unblock click type press fill drag drop hover navigate scroll
  upgrade downgrade scale restore migrate seed provision trigger dispatch close reopen resolve transition spawn
  message webhook hook notify emit fire broadcast launch perform backup alter sudo prune rewrite overwrite clean cleanup
  rotate vacuum flush discard squash nuke expire evict invalidate toggle rebase amend checkout login logout log`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Write verbs that are far more often nouns in tool names (`get_post`, `list_orders`, `get_email`). They count as
 * a write verb when they are the first word, follow a conjunction (`get_and_post`), or the name has no read verb
 * first. Everything else in WRITE_WORDS blocks wherever it appears (`get_and_drop`).
 */
export const AMBIGUOUS_WORDS = new Set(
  `post order book comment email star like type message reply block log`
    .split(/\s+/)
    .filter(Boolean),
);

/** Conjunctions that start a second action in a name: `get_and_post`, `read_then_send`. */
const CONJUNCTIONS = new Set(['and', 'then', 'or', 'plus']);

/**
 * Words that can mean either reading or writing depending on input (`query`, `sql`, `request`). A name with one
 * of these and no write verb is never allowed by name alone; it falls through to the description and then to
 * unclassified (blocked by default).
 */
export const OPAQUE_WORDS = new Set(
  `query sql graphql gql cypher request http curl command cmd shell script raw rpc`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Verbs that only observe. They clear a name only in verb position (see nameSignal). Nouns that merely sound
 * like reading (status, history, logs, schema, tree, snapshot, metadata, stats, diff, check, info, version, ...)
 * are deliberately absent: `prune_history`, `tree_prune` and `check_in_file` must not pass on them.
 */
export const READ_WORDS = new Set(
  `get list read search find fetch describe show view lookup look inspect count stat explain preview browse
  retrieve validate verify analyze analyse summarize summarise compare grep peek echo ping whoami dump print
  watch poll estimate scan audit cat ls du which`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Leading words that name a product or area rather than an action, so the verb comes after them:
 * `git_show`, `browser_get_text`, `k8s_list_pods`, `aws_s3_list_buckets`.
 */
export const NAMESPACE_WORDS = new Set(
  `git github gh gitlab bitbucket browser playwright puppeteer k8s kube kubernetes kubectl helm docker fs filesystem
  db database postgres pg mysql sqlite redis mongo mongodb s3 aws gcp gcloud azure slack notion jira linear
  confluence npm mcp web memory vault obsidian sentry`
    .split(/\s+/)
    .filter(Boolean),
);

/** Split `createPullRequest`, `delete_file`, `repo.list-issues`, `fs/read` into lowercase words. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Glob match on tool names: `*` any run, `?` one char; case-insensitive; full match. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\*+/g, '*')
        .split('')
        .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
    'is',
  );
  return re.test(name);
}

type Signal = { kind: 'write' | 'read' | 'opaque' | 'chained' | 'unknown'; word: string };

function nameSignal(name: string): Signal | null {
  const tokens = tokenize(name);
  if (tokens.length === 0) return null;
  let v = 0; // index of the verb: the first word after any namespace prefix
  while (v < tokens.length - 1 && NAMESPACE_WORDS.has(tokens[v]!)) v++;
  const verbIsRead = READ_WORDS.has(tokens[v]!);
  const w = tokens.find(
    (t, i) =>
      WRITE_WORDS.has(t) && (!AMBIGUOUS_WORDS.has(t) || i <= v || !verbIsRead || CONJUNCTIONS.has(tokens[i - 1]!)),
  );
  if (w) return { kind: 'write', word: w };
  // `scan_and_fix`: a second action after a conjunction must itself be a known read, else fail closed
  for (let i = 0; i < tokens.length - 1; i++) {
    if (CONJUNCTIONS.has(tokens[i]!) && !READ_WORDS.has(tokens[i + 1]!)) return { kind: 'chained', word: tokens[i + 1]! };
  }
  const o = tokens.find((t) => OPAQUE_WORDS.has(t));
  if (o) return { kind: 'opaque', word: o };
  // only the verb position counts: `get_history` reads, `prune_history` / `tree_prune` / `log_event` do not
  return verbIsRead ? { kind: 'read', word: tokens[v]! } : { kind: 'unknown', word: tokens[v]! };
}

/** Words in WRITE_WORDS that are usually nouns in prose ("a set of", "the new", "the store"): writes only as the first word. */
const DESCRIPTION_NOUNS = new Set([
  ...AMBIGUOUS_WORDS,
  ...'set new store release lock hook order call commit merge archive backup schedule upload transfer charge refund invite install export import'.split(' '),
]);

/** `wipes` -> wipe, `copies` -> copy, `updated` -> update, `creating` -> create, ... */
function stems(word: string): string[] {
  return [
    word,
    word.replace(/ies$/, 'y'),
    word.replace(/es$/, ''),
    word.replace(/s$/, ''),
    word.replace(/ed$/, ''),
    word.replace(/d$/, ''),
    word.replace(/ing$/, ''),
    word.replace(/ing$/, 'e'),
  ];
}

/**
 * Description heuristic: the first write verb anywhere in the description, or null. Negations and disclaimers
 * ("Deletes all records. Not available in read-only mode.") cannot make a writing tool look safe, and there is
 * deliberately no "read-only" phrase rule. A description never allows a tool by itself; it can only block.
 */
function descriptionWrite(desc: unknown): string | null {
  if (typeof desc !== 'string' || !desc.trim()) return null;
  const words = desc.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find((word, i) => stems(word).some((c) => WRITE_WORDS.has(c) && (i === 0 || !DESCRIPTION_NOUNS.has(c)))) ?? null;
}

export function classifyTool(tool: ToolInfo, policy: Policy = defaultPolicy): Verdict {
  const warnings: string[] = [];
  const name = tool.name;
  const deny = policy.deny.find((p) => globMatch(p, name));
  if (deny !== undefined) return { allowed: false, source: 'deny', reason: `matches --deny "${deny}"`, warnings };
  const allow = policy.allow.find((p) => globMatch(p, name));
  if (allow !== undefined) return { allowed: true, source: 'allow', reason: `matches --allow "${allow}"`, warnings };

  const a = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : undefined;
  const sig = nameSignal(name);
  if (a?.destructiveHint === true) {
    if (a.readOnlyHint === true) warnings.push('annotations contradict each other (readOnlyHint and destructiveHint both true)');
    return { allowed: false, source: 'annotation', reason: 'annotated destructiveHint: true', warnings };
  }
  const dw = descriptionWrite(tool.description);
  if (a?.readOnlyHint === true) {
    if (dw !== null) {
      if (policy.distrustAnnotations)
        return {
          allowed: false,
          source: 'description',
          reason: `description contains write verb "${dw}" (readOnlyHint: true ignored by --distrust-annotations)`,
          warnings,
        };
      warnings.push(`annotated readOnlyHint: true but the description contains write verb "${dw}"`);
    }
    if (sig?.kind === 'write') {
      if (policy.distrustAnnotations)
        return {
          allowed: false,
          source: 'name',
          reason: `name contains write verb "${sig.word}" (readOnlyHint: true ignored by --distrust-annotations)`,
          warnings,
        };
      warnings.push(`annotated readOnlyHint: true but the name contains write verb "${sig.word}"`);
    }
    return { allowed: true, source: 'annotation', reason: 'annotated readOnlyHint: true', warnings };
  }
  if (a?.readOnlyHint === false) {
    return { allowed: false, source: 'annotation', reason: 'annotated readOnlyHint: false', warnings };
  }
  if (sig?.kind === 'write') {
    return { allowed: false, source: 'name', reason: `no readOnlyHint; name contains write verb "${sig.word}"`, warnings };
  }
  // the description is always checked, also when the name reads, and it can only block
  if (dw !== null) {
    const pre = sig?.kind === 'read' ? `name starts with read verb "${sig.word}" but ` : '';
    return { allowed: false, source: 'description', reason: `no readOnlyHint; ${pre}description contains write verb "${dw}"`, warnings };
  }
  if (sig?.kind === 'read') {
    return { allowed: true, source: 'name', reason: `no readOnlyHint; name starts with read verb "${sig.word}"`, warnings };
  }
  const why =
    sig?.kind === 'opaque'
      ? `name contains "${sig.word}", which can read or write`
      : sig?.kind === 'chained'
        ? `name chains a second action "${sig.word}" that is not a known read`
        : sig?.kind === 'unknown'
          ? `"${sig.word}" is not a known read verb`
          : 'no annotations, no recognizable verb';
  return policy.unknown === 'allow'
    ? { allowed: true, source: 'default', reason: `unclassified (${why}); allowed by --unknown allow`, warnings }
    : { allowed: false, source: 'default', reason: `unclassified (${why}); blocked by default`, warnings };
}
