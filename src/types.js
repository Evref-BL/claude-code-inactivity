// Shared typedefs only (docs/design.md 9.1 and 9.3). No runtime code.

/** @typedef {'easy'|'medium'|'hard'} Difficulty */
/** @typedef {'haiku'|'sonnet'|'opus'} Tier */
/** @typedef {{login:string, type:'User'|'Bot'|'Organization'|'Mannequin'|string}|null} Author */
/** @typedef {{id:string, databaseId:number, author:Author, createdAt:string, lastEditedAt:string|null, isMinimized:boolean, body:string}} Comment */

/**
 * @typedef {Object} BoardItem
 * @property {string} itemId            ProjectV2Item node id
 * @property {string} issueNodeId       Issue/PR node id (comment target)
 * @property {string} id                'owner/repo#number'
 * @property {string} repo              'owner/repo'
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string} url
 * @property {'Issue'|'PullRequest'} contentType
 * @property {'OPEN'|'CLOSED'|'MERGED'} state
 * @property {string|null} authorLogin
 * @property {string} authorAssociation
 * @property {string[]} labels
 * @property {{priority:string|null, difficulty:string|null, status:string|null, agent:string|null}} fields
 * @property {Comment[]} comments
 * @property {boolean} commentsComplete
 * @property {string} updatedAt
 */

/** @typedef {{id:string, title:string, ownerType:'organization'|'user', fields:Record<string,{id:string, dataType:string, options?:Record<string,string>}>}} ProjectInfo */
/** @typedef {{capacity:number, models:Tier[]}} Offer */
/** @typedef {{kind:string, payload:object, member:string, task:string, round:1|2, createdAt:string, databaseId:number, commentId:string}} ClaimEvent */
/** @typedef {{task:string, member:string, model:Tier, difficulty:Difficulty, points:number, rank:number}} Assignment */
/** @typedef {{round:1|2, ready:boolean, assignments:Assignment[], unassigned:{task:string, reason:string}[], loads:Record<string,number>, inputsDigest:string, rejected:{commentId:string, reason:string}[]}} RoundResult */
/** @typedef {{round:1|2, claimStart:Date, claimEnd:Date, resolveAt:Date, state:'pending'|'open'|'closed'|'resolved'}} RoundPhase */
/** @typedef {{cycle:string, active:boolean, rounds:{1:RoundPhase, 2:RoundPhase|null}, startDeadline:Date, executionEnd:Date, executionOpen:boolean}} CyclePhases */

/**
 * @typedef {Object} ExecOptions
 * @property {string} [cwd]
 * @property {Record<string,string|undefined>} [env]        full child env (not merged) when given
 * @property {string} [stdin]
 * @property {number} [timeoutMs]                           soft stop: SIGINT, then SIGTERM after killGraceMs, then SIGKILL
 * @property {number} [killGraceMs]                         default 15000
 * @property {{stdout?:string, stderr?:string}} [tee]       file paths receiving the raw streams
 * @property {number} [maxBuffer]                           bytes of each stream returned (tail kept); default 8 MiB
 */

/**
 * @typedef {Object} ExecResult
 * @property {number|null} code                             null when killed by signal
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {number} durationMs
 * @property {boolean} [teed]                               true when `tee` files were written by exec
 */

/**
 * @typedef {Object} Deps
 * @property {(cmd:string, args:string[], opts?:ExecOptions) => Promise<ExecResult>} exec
 * @property {() => Date} now
 * @property {typeof import('node:fs/promises')} fs
 * @property {Record<string,string|undefined>} env
 * @property {typeof fetch} fetch
 * @property {{debug:Function, info:Function, warn:Function, error:Function}} log
 * @property {string} platform
 * @property {() => string} homedir
 * @property {(ms:number) => Promise<void>} sleep
 * @property {() => string} randomHex                       4 hex chars
 * @property {{execPath:string, pid:number, uid:number|null}} proc
 */

export {};
