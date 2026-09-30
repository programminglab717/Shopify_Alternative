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
  // KEYS: lock, IDs by handle, handles by ID, then the documents' keys.
  // ARGV: token, lock ms, then each document's ID, handle and JSON.
  sfPut: {
    lua: `${HOLDING}
for i = 4, #KEYS do
  local at = 3 + (i - 4) * 3
  local id, handle = ARGV[at], ARGV[at + 1]
  local old = redis.call('HGET', KEYS[3], id)
  if old and old ~= handle and redis.call('HGET', KEYS[2], old) == id then
    redis.call('HDEL', KEYS[2], old)
  end
  redis.call('HSET', KEYS[2], handle, id)
  redis.call('HSET', KEYS[3], id, handle)
  redis.call('SET', KEYS[i], ARGV[at + 2])
end
return 1`,
  },
  // KEYS: lock, IDs by handle, handles by ID, then the documents' keys. ARGV: token, lock ms,
  // then the documents' IDs.
  sfDrop: {
    lua: `${HOLDING}
for i = 4, #KEYS do
  local id = ARGV[i - 1]
  local handle = redis.call('HGET', KEYS[3], id)
  if handle then
    if redis.call('HGET', KEYS[2], handle) == id then redis.call('HDEL', KEYS[2], handle) end
    redis.call('HDEL', KEYS[3], id)
  end
  redis.call('DEL', KEYS[i])
end
return 1`,
  },
  // KEYS: lock, then keys. ARGV: token, lock ms, then their values.
  sfSet: {
    lua: `${HOLDING}
for i = 2, #KEYS do redis.call('SET', KEYS[i], ARGV[i + 1]) end
return 1`,
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
  sfUnmap(hash: string, field: string, value: string): Promise<number>;
  sfByHandle(ids: string, handle: string, prefix: string): Promise<string | null>;
};

export function scripted(redis: Redis): ScriptedRedis {
  if (!('sfByHandle' in redis)) {
    for (const [name, definition] of Object.entries(SCRIPTS)) {
      redis.defineCommand(name, definition);
    }
  }
  return redis as ScriptedRedis;
}
