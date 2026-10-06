import type { Redis } from 'ioredis';

// Scripts run atomically in Valkey. The writes check the shop's build lock first, so a publisher
// that lost it, having taken too long, cannot write over what the lock's new holder built from
// newer data.

/** Puts back what a publisher took and did not finish, lowest priority kept. */
const PUT_BACK = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('ZUNIONSTORE', KEYS[2], 2, KEYS[2], KEYS[3], 'AGGREGATE', 'MIN')
  redis.call('DEL', KEYS[3])
end`;

const HOLDING = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
redis.call('PEXPIRE', KEYS[1], ARGV[2])`;

const SCRIPTS = {
  // KEYS: lock, pending, taken. ARGV: token, lock ms.
  sfClaim: {
    numberOfKeys: 3,
    lua: `
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 0 end
${PUT_BACK}
return 1`,
  },
  // KEYS: lock, pending, taken. ARGV: token, lock ms, how many.
  sfTake: {
    numberOfKeys: 3,
    lua: `${HOLDING}
local popped = redis.call('ZPOPMIN', KEYS[2], ARGV[3])
local items = {}
for i = 1, #popped, 2 do
  redis.call('ZADD', KEYS[3], popped[i + 1], popped[i])
  items[#items + 1] = popped[i]
end
return items`,
  },
  // KEYS: lock, taken. ARGV: token, lock ms.
  sfFinish: {
    numberOfKeys: 2,
    lua: `${HOLDING}
redis.call('DEL', KEYS[2])
return 1`,
  },
  // KEYS: lock, pending, taken. ARGV: token.
  sfGiveBack: {
    numberOfKeys: 3,
    lua: `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
${PUT_BACK}
return 1`,
  },
  // KEYS: lock. ARGV: token.
  sfRelease: {
    numberOfKeys: 1,
    lua: `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`,
  },
  // Documents with handles. A document's old handle is let go only if it still leads to the
  // document: another may have taken it since, as when two products swap handles.
  // KEYS: lock, IDs by handle, handles by ID, sitemap entries by ID, then the documents' keys.
  // ARGV: token, lock ms, then each document's ID, handle, JSON and sitemap entry (ADR-236).
  sfPut: {
    lua: `${HOLDING}
for i = 5, #KEYS do
  local at = 3 + (i - 5) * 4
  local id, handle = ARGV[at], ARGV[at + 1]
  local old = redis.call('HGET', KEYS[3], id)
  if old and old ~= handle and redis.call('HGET', KEYS[2], old) == id then
    redis.call('HDEL', KEYS[2], old)
  end
  redis.call('HSET', KEYS[2], handle, id)
  redis.call('HSET', KEYS[3], id, handle)
  redis.call('HSET', KEYS[4], id, ARGV[at + 3])
  redis.call('SET', KEYS[i], ARGV[at + 2])
end
return 1`,
  },
  // KEYS: lock, IDs by handle, handles by ID, sitemap entries by ID, then the documents' keys.
  // ARGV: token, lock ms, then the documents' IDs.
  sfDrop: {
    lua: `${HOLDING}
for i = 5, #KEYS do
  local id = ARGV[i - 2]
  local handle = redis.call('HGET', KEYS[3], id)
  if handle then
    if redis.call('HGET', KEYS[2], handle) == id then redis.call('HDEL', KEYS[2], handle) end
    redis.call('HDEL', KEYS[3], id)
  end
  redis.call('HDEL', KEYS[4], id)
  redis.call('DEL', KEYS[i])
end
return 1`,
  },
  // KEYS: lock, then keys. ARGV: token, lock ms.
  sfDel: {
    lua: `${HOLDING}
for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
return 1`,
  },
  // Writes a hash whole: a field not given goes.
  // KEYS: lock, the hash. ARGV: token, lock ms, then each field and its value.
  sfSetHash: {
    numberOfKeys: 2,
    lua: `${HOLDING}
redis.call('DEL', KEYS[2])
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1]) end
return 1`,
  },
  // Changes a hash in part: fields go, then others are set.
  // KEYS: lock, the hash. ARGV: token, lock ms, how many fields go, those fields, then each field
  // to set and its value.
  sfChangeHash: {
    numberOfKeys: 2,
    lua: `${HOLDING}
local gone = tonumber(ARGV[3])
for i = 4, 3 + gone do redis.call('HDEL', KEYS[2], ARGV[i]) end
for i = 4 + gone, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1]) end
return 1`,
  },
  // KEYS: lock, then keys. ARGV: token, lock ms, then their values.
  sfSet: {
    lua: `${HOLDING}
for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[i + 1]) end
return 1`,
  },
  // Lists a shop as waiting from now, or just after when it was listed last: each listing moves
  // its score on, so a score read before one is never taken for it.
  // KEYS: waiting. ARGV: now in milliseconds, the shop.
  sfList: {
    numberOfKeys: 1,
    lua: `
local score = tonumber(ARGV[1])
local was = redis.call('ZSCORE', KEYS[1], ARGV[2])
if was and tonumber(was) >= score then score = tonumber(was) + 1 end
redis.call('ZADD', KEYS[1], score, ARGV[2])
return 1`,
  },
  // The shops listed up to a time, the longest waiting first, each listed again from now, so a
  // sweep running beside this one doesn't take them too.
  // KEYS: waiting. ARGV: up to, now, in milliseconds, how many.
  sfTakeWaiting: {
    numberOfKeys: 1,
    lua: `
local shops = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[3])
for _, shop in ipairs(shops) do
  local score = tonumber(ARGV[2])
  local was = tonumber(redis.call('ZSCORE', KEYS[1], shop))
  if was >= score then score = was + 1 end
  redis.call('ZADD', KEYS[1], score, shop)
end
return shops`,
  },
  // Takes a shop off the list only if it is still listed as it was when its score was read.
  // KEYS: waiting. ARGV: the shop, its score as read.
  sfUnlist: {
    numberOfKeys: 1,
    lua: `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('ZREM', KEYS[1], ARGV[1]) end
return 0`,
  },
  // Lets go of a field only if it still holds the value: a handle another shop has since taken
  // stays that shop's.
  // KEYS: the hash. ARGV: the field, the value.
  sfUnmap: {
    numberOfKeys: 1,
    lua: `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('HDEL', KEYS[1], ARGV[1]) end
return 0`,
  },
  // A document by its handle, in one round trip. The document's key is not declared: it is
  // learnt from the handle, and shares the shop's slot by its hash tag.
  // KEYS: IDs by handle. ARGV: the handle, the documents' key prefix.
  sfByHandle: {
    numberOfKeys: 1,
    lua: `
local id = redis.call('HGET', KEYS[1], ARGV[1])
if not id then return false end
return redis.call('GET', ARGV[2] .. id)`,
  },
} satisfies Record<string, { numberOfKeys?: number; lua: string }>;

type Arg = string | number;

/** A connection with the storefront's scripts. Those without a fixed key count take it first. */
export type ScriptedRedis = Redis & {
  sfClaim(lock: string, pending: string, taken: string, token: string, ms: number): Promise<number>;
  sfTake(
    lock: string,
    pending: string,
    taken: string,
    token: string,
    ms: number,
    count: number,
  ): Promise<string[] | null>;
  sfFinish(lock: string, taken: string, token: string, ms: number): Promise<number | null>;
  sfGiveBack(lock: string, pending: string, taken: string, token: string): Promise<number>;
  sfRelease(lock: string, token: string): Promise<number>;
  sfPut(keyCount: number, ...args: Arg[]): Promise<number | null>;
  sfDrop(keyCount: number, ...args: Arg[]): Promise<number | null>;
  sfSet(keyCount: number, ...args: Arg[]): Promise<number | null>;
  sfSetHash(
    lock: string,
    hash: string,
    token: string,
    ms: number,
    ...pairs: string[]
  ): Promise<number | null>;
  sfChangeHash(
    lock: string,
    hash: string,
    token: string,
    ms: number,
    gone: number,
    ...fields: string[]
  ): Promise<number | null>;
  sfDel(keyCount: number, ...args: Arg[]): Promise<number | null>;
  sfUnmap(hash: string, field: string, value: string): Promise<number>;
  sfList(waiting: string, now: number, shopId: string): Promise<number>;
  sfTakeWaiting(waiting: string, upTo: number, now: number, count: number): Promise<string[]>;
  sfUnlist(waiting: string, shopId: string, score: string): Promise<number>;
  sfByHandle(ids: string, handle: string, prefix: string): Promise<string | null>;
};

export function scripted(redis: Redis): ScriptedRedis {
  for (const [name, definition] of Object.entries(SCRIPTS)) {
    if (!(name in redis)) redis.defineCommand(name, definition);
  }
  return redis as ScriptedRedis;
}
