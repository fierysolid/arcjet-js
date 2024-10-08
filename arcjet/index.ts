import type {
  ArcjetContext,
  ArcjetEmailRule,
  ArcjetBotRule,
  ArcjetRule,
  ArcjetLocalRule,
  ArcjetRequestDetails,
  ArcjetTokenBucketRateLimitRule,
  ArcjetFixedWindowRateLimitRule,
  ArcjetSlidingWindowRateLimitRule,
  ArcjetShieldRule,
  ArcjetLogger,
  ArcjetSensitiveInfoRule,
  ArcjetIdentifiedEntity,
  ArcjetWellKnownBot,
} from "@arcjet/protocol";
import {
  ArcjetBotReason,
  ArcjetEmailReason,
  ArcjetEmailType,
  ArcjetErrorReason,
  ArcjetMode,
  ArcjetReason,
  ArcjetRuleResult,
  ArcjetSensitiveInfoType,
  ArcjetSensitiveInfoReason,
  ArcjetDecision,
  ArcjetDenyDecision,
  ArcjetErrorDecision,
} from "@arcjet/protocol";
import { isRateLimitRule } from "@arcjet/protocol/convert.js";
import type { Client } from "@arcjet/protocol/client.js";
import * as analyze from "@arcjet/analyze";
import type {
  DetectedSensitiveInfoEntity,
  SensitiveInfoEntity,
  BotConfig,
} from "@arcjet/analyze";
import * as duration from "@arcjet/duration";
import ArcjetHeaders from "@arcjet/headers";
import { runtime } from "@arcjet/runtime";

export * from "@arcjet/protocol";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(msg);
  }
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

class Cache<T> {
  expires: Map<string, number>;
  data: Map<string, T>;

  constructor() {
    this.expires = new Map();
    this.data = new Map();
  }

  get(key: string) {
    const ttl = this.ttl(key);
    if (ttl > 0) {
      return this.data.get(key);
    } else {
      // Cleanup if expired
      this.expires.delete(key);
      this.data.delete(key);
    }
  }

  set(key: string, value: T, expiresAt: number) {
    this.expires.set(key, expiresAt);
    this.data.set(key, value);
  }

  ttl(key: string): number {
    const now = nowInSeconds();
    const expiresAt = this.expires.get(key) ?? now;
    return expiresAt - now;
  }
}

function errorMessage(err: unknown): string {
  if (err) {
    if (typeof err === "string") {
      return err;
    }

    if (
      typeof err === "object" &&
      "message" in err &&
      typeof err.message === "string"
    ) {
      return err.message;
    }
  }

  return "Unknown problem";
}

// Type helpers from https://github.com/sindresorhus/type-fest but adjusted for
// our use.
//
// Simplify:
// https://github.com/sindresorhus/type-fest/blob/964466c9d59c711da57a5297ad954c13132a0001/source/simplify.d.ts
// UnionToIntersection:
// https://github.com/sindresorhus/type-fest/blob/017bf38ebb52df37c297324d97bcc693ec22e920/source/union-to-intersection.d.ts
// IsNever:
// https://github.com/sindresorhus/type-fest/blob/e02f228f6391bb2b26c32a55dfe1e3aa2386d515/source/primitive.d.ts
// LiteralCheck & IsStringLiteral:
// https://github.com/sindresorhus/type-fest/blob/e02f228f6391bb2b26c32a55dfe1e3aa2386d515/source/is-literal.d.ts
//
// Licensed: MIT License Copyright (c) Sindre Sorhus <sindresorhus@gmail.com>
// (https://sindresorhus.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};
type UnionToIntersection<Union> =
  // `extends unknown` is always going to be the case and is used to convert the
  // `Union` into a [distributive conditional
  // type](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-8.html#distributive-conditional-types).
  (
    Union extends unknown
      ? // The union type is used as the only argument to a function since the union
        // of function arguments is an intersection.
        (distributedUnion: Union) => void
      : // This won't happen.
        never
  ) extends // Infer the `Intersection` type since TypeScript represents the positional
  // arguments of unions of functions as an intersection of the union.
  (mergedIntersection: infer Intersection) => void
    ? // The `& Union` is to allow indexing by the resulting type
      Intersection & Union
    : never;
type IsNever<T> = [T] extends [never] ? true : false;
type LiteralCheck<
  T,
  LiteralType extends
    | null
    | undefined
    | string
    | number
    | boolean
    | symbol
    | bigint,
> =
  IsNever<T> extends false // Must be wider than `never`
    ? [T] extends [LiteralType] // Must be narrower than `LiteralType`
      ? [LiteralType] extends [T] // Cannot be wider than `LiteralType`
        ? false
        : true
      : false
    : false;
type IsStringLiteral<T> = LiteralCheck<T, string>;

const knownFields = [
  "ip",
  "method",
  "protocol",
  "host",
  "path",
  "headers",
  "body",
  "email",
  "cookies",
  "query",
];

function isUnknownRequestProperty(key: string) {
  return !knownFields.includes(key);
}

function isEmailType(type: string): type is ArcjetEmailType {
  return (
    type === "FREE" ||
    type === "DISPOSABLE" ||
    type === "NO_MX_RECORDS" ||
    type === "NO_GRAVATAR" ||
    type === "INVALID"
  );
}

function toString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return `${value}`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return "<unsupported value>";
}

function toAnalyzeRequest(request: Partial<ArcjetRequestDetails>) {
  const headers: Record<string, string> = {};
  if (typeof request.headers !== "undefined") {
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
  }

  return {
    ...request,
    headers,
  };
}

function extraProps<Props extends PlainObject>(
  details: ArcjetRequest<Props>,
): Record<string, string> {
  const extra: Map<string, string> = new Map();
  for (const [key, value] of Object.entries(details)) {
    if (isUnknownRequestProperty(key)) {
      extra.set(key, toString(value));
    }
  }
  return Object.fromEntries(extra.entries());
}

type TokenBucketRateLimitOptions<Characteristics extends readonly string[]> = {
  mode?: ArcjetMode;
  match?: string;
  characteristics?: Characteristics;
  refillRate: number;
  interval: string | number;
  capacity: number;
};

type FixedWindowRateLimitOptions<Characteristics extends readonly string[]> = {
  mode?: ArcjetMode;
  match?: string;
  characteristics?: Characteristics;
  window: string | number;
  max: number;
};

type SlidingWindowRateLimitOptions<Characteristics extends readonly string[]> =
  {
    mode?: ArcjetMode;
    match?: string;
    characteristics?: Characteristics;
    interval: string | number;
    max: number;
  };

type BotOptionsAllow = {
  mode?: ArcjetMode;
  allow: Array<ArcjetWellKnownBot>;
  deny?: never;
};

type BotOptionsDeny = {
  mode?: ArcjetMode;
  allow?: never;
  deny: Array<ArcjetWellKnownBot>;
};

export type BotOptions = BotOptionsAllow | BotOptionsDeny;

export type EmailOptions = {
  mode?: ArcjetMode;
  block?: ArcjetEmailType[];
  requireTopLevelDomain?: boolean;
  allowDomainLiteral?: boolean;
};

type DetectSensitiveInfoEntities<T> = (
  tokens: string[],
) => Array<ArcjetSensitiveInfoType | T | undefined>;

type ValidEntities<Detect> = Array<
  // Via https://www.reddit.com/r/typescript/comments/17up72w/comment/k958cb0/
  // Conditional types distribute over unions. If you have ((string | undefined)
  // extends undefined ? 1 : 0) it is evaluated separately for each member of
  // the union, then union-ed together again. The result is (string extends
  // undefined ? 1 : 0) | (undefined extends undefined ? 1 : 0) which simplifies
  // to 0 | 1
  undefined extends Detect
    ? ArcjetSensitiveInfoType
    : Detect extends DetectSensitiveInfoEntities<infer CustomEntities>
      ? ArcjetSensitiveInfoType | CustomEntities
      : never
>;

type SensitiveInfoOptionsAllow<Detect> = {
  allow: ValidEntities<Detect>;
  deny?: never;
  contextWindowSize?: number;
  mode?: ArcjetMode;
  detect?: Detect;
};

type SensitiveInfoOptionsDeny<Detect> = {
  allow?: never;
  deny: ValidEntities<Detect>;
  contextWindowSize?: number;
  mode?: ArcjetMode;
  detect?: Detect;
};

export type SensitiveInfoOptions<Detect> =
  | SensitiveInfoOptionsAllow<Detect>
  | SensitiveInfoOptionsDeny<Detect>;

const Priority = {
  SensitiveInfo: 1,
  Shield: 2,
  RateLimit: 3,
  BotDetection: 4,
  EmailValidation: 5,
};

type PlainObject = { [key: string]: unknown };

// Primitives and Products external names for Rules even though they are defined
// the same.
// See ExtraProps below for further explanation on why we define them like this.
export type Primitive<Props extends PlainObject = {}> = ArcjetRule<Props>[];
export type Product<Props extends PlainObject = {}> = ArcjetRule<Props>[];

// User-defined characteristics alter the required props of an ArcjetRequest
// Note: If a user doesn't provide the object literal to our primitives
// directly, we fallback to no required props. They can opt-in by adding the
// `as const` suffix to the characteristics array.
type PropsForCharacteristic<T> =
  IsStringLiteral<T> extends true
    ? T extends
        | "ip.src"
        | "http.host"
        | "http.method"
        | "http.request.uri.path"
        | `http.request.headers["${string}"]`
        | `http.request.cookie["${string}"]`
        | `http.request.uri.args["${string}"]`
      ? {}
      : T extends string
        ? Record<T, string | number | boolean>
        : never
    : {};
export type CharacteristicProps<Characteristics extends readonly string[]> =
  UnionToIntersection<PropsForCharacteristic<Characteristics[number]>>;
// Rules can specify they require specific props on an ArcjetRequest
type PropsForRule<R> = R extends ArcjetRule<infer Props> ? Props : {};
// We theoretically support an arbitrary amount of rule flattening,
// but one level seems to be easiest; however, this puts a constraint of
// the definition of `Product` such that they need to spread each `Primitive`
// they are re-exporting.
export type ExtraProps<Rules> = Rules extends []
  ? {}
  : Rules extends ArcjetRule[][]
    ? UnionToIntersection<PropsForRule<Rules[number][number]>>
    : Rules extends ArcjetRule[]
      ? UnionToIntersection<PropsForRule<Rules[number]>>
      : never;

/**
 * Additional context that can be provided by adapters.
 *
 * Among other things, this could include the Arcjet API Key if it were only
 * available in a runtime handler or IP details provided by a platform.
 */
export type ArcjetAdapterContext = {
  [key: string]: unknown;
  getBody(): Promise<string | undefined>;
};

/**
 * @property {string} ip - The IP address of the client.
 * @property {string} method - The HTTP method of the request.
 * @property {string} protocol - The protocol of the request.
 * @property {string} host - The host of the request.
 * @property {string} path - The path of the request.
 * @property {Headers} headers - The headers of the request.
 * @property {string} cookies - The string representing semicolon-separated Cookies for a request.
 * @property {string} query - The `?`-prefixed string representing the Query for a request. Commonly referred to as a "querystring".
 * @property {string} email - An email address related to the request.
 * @property ...extra - Extra data that might be useful for Arcjet. For example, requested tokens are specified as the `requested` property.
 */
export type ArcjetRequest<Props extends PlainObject> = Simplify<
  {
    [key: string]: unknown;
    ip?: string;
    method?: string;
    protocol?: string;
    host?: string;
    path?: string;
    headers?: Headers | Record<string, string | string[] | undefined>;
    cookies?: string;
    query?: string;
  } & Props
>;

function isLocalRule<Props extends PlainObject>(
  rule: ArcjetRule<Props>,
): rule is ArcjetLocalRule<Props> {
  return (
    "validate" in rule &&
    typeof rule.validate === "function" &&
    "protect" in rule &&
    typeof rule.protect === "function"
  );
}

export function tokenBucket<
  const Characteristics extends readonly string[] = [],
>(
  options?: TokenBucketRateLimitOptions<Characteristics>,
  ...additionalOptions: TokenBucketRateLimitOptions<Characteristics>[]
): Primitive<
  Simplify<
    UnionToIntersection<
      { requested: number } | CharacteristicProps<Characteristics>
    >
  >
> {
  const rules: ArcjetTokenBucketRateLimitRule<{ requested: number }>[] = [];

  if (typeof options === "undefined") {
    return rules;
  }

  for (const opt of [options, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    const match = opt.match;
    const characteristics = Array.isArray(opt.characteristics)
      ? opt.characteristics
      : undefined;

    const refillRate = opt.refillRate;
    const interval = duration.parse(opt.interval);
    const capacity = opt.capacity;

    rules.push({
      type: "RATE_LIMIT",
      priority: Priority.RateLimit,
      mode,
      match,
      characteristics,
      algorithm: "TOKEN_BUCKET",
      refillRate,
      interval,
      capacity,
    });
  }

  return rules;
}

export function fixedWindow<
  const Characteristics extends readonly string[] = [],
>(
  options?: FixedWindowRateLimitOptions<Characteristics>,
  ...additionalOptions: FixedWindowRateLimitOptions<Characteristics>[]
): Primitive<Simplify<CharacteristicProps<Characteristics>>> {
  const rules: ArcjetFixedWindowRateLimitRule<{}>[] = [];

  if (typeof options === "undefined") {
    return rules;
  }

  for (const opt of [options, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    const match = opt.match;
    const characteristics = Array.isArray(opt.characteristics)
      ? opt.characteristics
      : undefined;

    const max = opt.max;
    const window = duration.parse(opt.window);

    rules.push({
      type: "RATE_LIMIT",
      priority: Priority.RateLimit,
      mode,
      match,
      characteristics,
      algorithm: "FIXED_WINDOW",
      max,
      window,
    });
  }

  return rules;
}

export function slidingWindow<
  const Characteristics extends readonly string[] = [],
>(
  options?: SlidingWindowRateLimitOptions<Characteristics>,
  ...additionalOptions: SlidingWindowRateLimitOptions<Characteristics>[]
): Primitive<Simplify<CharacteristicProps<Characteristics>>> {
  const rules: ArcjetSlidingWindowRateLimitRule<{}>[] = [];

  if (typeof options === "undefined") {
    return rules;
  }

  for (const opt of [options, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    const match = opt.match;
    const characteristics = Array.isArray(opt.characteristics)
      ? opt.characteristics
      : undefined;

    const max = opt.max;
    const interval = duration.parse(opt.interval);

    rules.push({
      type: "RATE_LIMIT",
      priority: Priority.RateLimit,
      mode,
      match,
      characteristics,
      algorithm: "SLIDING_WINDOW",
      max,
      interval,
    });
  }

  return rules;
}

function protocolSensitiveInfoEntitiesToAnalyze<Custom extends string>(
  entity: ArcjetSensitiveInfoType | Custom,
) {
  if (typeof entity !== "string") {
    throw new Error("invalid entity type");
  }

  if (entity === "EMAIL") {
    return { tag: "email" as const };
  }

  if (entity === "PHONE_NUMBER") {
    return { tag: "phone-number" as const };
  }

  if (entity === "IP_ADDRESS") {
    return { tag: "ip-address" as const };
  }

  if (entity === "CREDIT_CARD_NUMBER") {
    return { tag: "credit-card-number" as const };
  }

  return {
    tag: "custom" as const,
    val: entity,
  };
}

function analyzeSensitiveInfoEntitiesToString(
  entity: SensitiveInfoEntity,
): string {
  if (entity.tag === "email") {
    return "EMAIL";
  }

  if (entity.tag === "ip-address") {
    return "IP_ADDRESS";
  }

  if (entity.tag === "credit-card-number") {
    return "CREDIT_CARD_NUMBER";
  }

  if (entity.tag === "phone-number") {
    return "PHONE_NUMBER";
  }

  return entity.val;
}

function convertAnalyzeDetectedSensitiveInfoEntity(
  detectedEntities: DetectedSensitiveInfoEntity[],
): ArcjetIdentifiedEntity[] {
  return detectedEntities.map((detectedEntity) => {
    return {
      ...detectedEntity,
      identifiedType: analyzeSensitiveInfoEntitiesToString(
        detectedEntity.identifiedType,
      ),
    };
  });
}

export function sensitiveInfo<
  const Detect extends DetectSensitiveInfoEntities<CustomEntities> | undefined,
  const CustomEntities extends string,
>(
  options: SensitiveInfoOptions<Detect>,
  ...additionalOptions: SensitiveInfoOptions<Detect>[]
): Primitive<{}> {
  const rules: ArcjetSensitiveInfoRule<{}>[] = [];

  // Always create at least one SENSITIVE_INFO rule
  for (const opt of [options, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    if (typeof opt.allow !== "undefined" && typeof opt.deny !== "undefined") {
      throw new Error(
        "Both allow and deny cannot be provided to sensitiveInfo",
      );
    }

    rules.push({
      type: "SENSITIVE_INFO",
      priority: Priority.SensitiveInfo,
      mode,
      allow: opt.allow || [],
      deny: opt.deny || [],

      validate(
        context: ArcjetContext,
        details: ArcjetRequestDetails,
      ): asserts details is ArcjetRequestDetails {},

      async protect(
        context: ArcjetContext,
        details: ArcjetRequestDetails,
      ): Promise<ArcjetRuleResult> {
        const body = await context.getBody();
        if (typeof body === "undefined") {
          return new ArcjetRuleResult({
            ttl: 0,
            state: "NOT_RUN",
            conclusion: "ERROR",
            reason: new ArcjetErrorReason(
              "Couldn't read the body of the request to perform sensitive info identification.",
            ),
          });
        }

        let convertedDetect = undefined;
        if (typeof opt.detect !== "undefined") {
          const detect = opt.detect;
          convertedDetect = (tokens: string[]) => {
            return detect(tokens)
              .filter((e) => typeof e !== "undefined")
              .map(protocolSensitiveInfoEntitiesToAnalyze);
          };
        }

        let entitiesTag: "allow" | "deny" = "allow";
        let entitiesVal: Array<
          ReturnType<typeof protocolSensitiveInfoEntitiesToAnalyze>
        > = [];

        if (Array.isArray(opt.allow)) {
          entitiesTag = "allow";
          entitiesVal = opt.allow
            .filter((e) => typeof e !== "undefined")
            .map(protocolSensitiveInfoEntitiesToAnalyze);
        }

        if (Array.isArray(opt.deny)) {
          entitiesTag = "deny";
          entitiesVal = opt.deny
            .filter((e) => typeof e !== "undefined")
            .map(protocolSensitiveInfoEntitiesToAnalyze);
        }

        const entities = {
          tag: entitiesTag,
          val: entitiesVal,
        };

        const result = await analyze.detectSensitiveInfo(
          context,
          body,
          entities,
          options.contextWindowSize || 1,
          convertedDetect,
        );

        const reason = new ArcjetSensitiveInfoReason({
          denied: convertAnalyzeDetectedSensitiveInfoEntity(result.denied),
          allowed: convertAnalyzeDetectedSensitiveInfoEntity(result.allowed),
        });

        if (result.denied.length === 0) {
          return new ArcjetRuleResult({
            ttl: 0,
            state: "RUN",
            conclusion: "ALLOW",
            reason,
          });
        } else {
          return new ArcjetRuleResult({
            ttl: 0,
            state: "RUN",
            conclusion: "DENY",
            reason,
          });
        }
      },
    });
  }

  return rules;
}

export function validateEmail(
  options?: EmailOptions,
  ...additionalOptions: EmailOptions[]
): Primitive<{ email: string }> {
  const rules: ArcjetEmailRule<{ email: string }>[] = [];

  // Always create at least one EMAIL rule
  for (const opt of [options ?? {}, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    // TODO: Filter invalid email types (or error??)
    const block = opt.block ?? [];
    const requireTopLevelDomain = opt.requireTopLevelDomain ?? true;
    const allowDomainLiteral = opt.allowDomainLiteral ?? false;

    const emailOpts = {
      requireTopLevelDomain,
      allowDomainLiteral,
      blockedEmails: block,
    };

    rules.push({
      type: "EMAIL",
      priority: Priority.EmailValidation,
      mode,
      block,
      requireTopLevelDomain,
      allowDomainLiteral,

      validate(
        context: ArcjetContext,
        details: Partial<ArcjetRequestDetails & { email: string }>,
      ): asserts details is ArcjetRequestDetails & { email: string } {
        assert(
          typeof details.email !== "undefined",
          "ValidateEmail requires `email` to be set.",
        );
      },

      async protect(
        context: ArcjetContext,
        { email }: ArcjetRequestDetails & { email: string },
      ): Promise<ArcjetRuleResult> {
        const result = await analyze.isValidEmail(context, email, emailOpts);
        if (result.validity === "valid") {
          return new ArcjetRuleResult({
            ttl: 0,
            state: "RUN",
            conclusion: "ALLOW",
            reason: new ArcjetEmailReason({ emailTypes: [] }),
          });
        } else {
          const typedEmailTypes = result.blocked.filter(isEmailType);

          return new ArcjetRuleResult({
            ttl: 0,
            state: "RUN",
            conclusion: "DENY",
            reason: new ArcjetEmailReason({
              emailTypes: typedEmailTypes,
            }),
          });
        }
      },
    });
  }

  return rules;
}

export function detectBot(
  options?: BotOptions,
  ...additionalOptions: BotOptions[]
): Primitive {
  const rules: ArcjetBotRule<{}>[] = [];

  // Always create at least one BOT rule
  for (const opt of [options ?? { allow: [] }, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    if (typeof opt.allow !== "undefined" && typeof opt.deny !== "undefined") {
      throw new Error("Both allow and deny cannot be provided to detectBot");
    }

    let config: BotConfig = {
      tag: "allowed-bot-config",
      val: {
        entities: [],
        skipCustomDetect: true,
      },
    };
    if (Array.isArray(opt.allow)) {
      for (const allow of opt.allow) {
        if (typeof allow !== "string") {
          throw new Error("all values in `allow` must be a string");
        }
      }

      config = {
        tag: "allowed-bot-config",
        val: {
          entities: opt.allow,
          skipCustomDetect: true,
        },
      };
    }

    if (Array.isArray(opt.deny)) {
      for (const deny of opt.deny) {
        if (typeof deny !== "string") {
          throw new Error("all values in `allow` must be a string");
        }
      }

      config = {
        tag: "denied-bot-config",
        val: {
          entities: opt.deny,
          skipCustomDetect: true,
        },
      };
    }

    rules.push({
      type: "BOT",
      priority: Priority.BotDetection,
      mode,
      allow: Array.isArray(opt.allow) ? opt.allow : [],
      deny: Array.isArray(opt.deny) ? opt.deny : [],

      validate(
        context: ArcjetContext,
        details: Partial<ArcjetRequestDetails>,
      ): asserts details is ArcjetRequestDetails {
        if (typeof details.headers === "undefined") {
          throw new Error("bot detection requires `headers` to be set");
        }
        if (typeof details.headers.has !== "function") {
          throw new Error(
            "bot detection requires `headers` to extend `Headers`",
          );
        }
        if (!details.headers.has("user-agent")) {
          throw new Error("bot detection requires user-agent header");
        }
      },

      /**
       * Attempts to call the bot detection on the headers.
       */
      async protect(
        context: ArcjetContext,
        request: ArcjetRequestDetails,
      ): Promise<ArcjetRuleResult> {
        const result = await analyze.detectBot(
          context,
          toAnalyzeRequest(request),
          config,
        );

        // If this is a bot and of a type that we want to block, then block!
        if (result.denied.length > 0) {
          return new ArcjetRuleResult({
            ttl: 60,
            state: "RUN",
            conclusion: "DENY",
            reason: new ArcjetBotReason({
              allowed: result.allowed,
              denied: result.denied,
            }),
          });
        } else {
          return new ArcjetRuleResult({
            ttl: 0,
            state: "RUN",
            conclusion: "ALLOW",
            reason: new ArcjetBotReason({
              allowed: result.allowed,
              denied: result.denied,
            }),
          });
        }
      },
    });
  }

  return rules;
}

export type ShieldOptions = {
  mode?: ArcjetMode;
};

export function shield(
  options?: ShieldOptions,
  ...additionalOptions: ShieldOptions[]
): Primitive {
  const rules: ArcjetShieldRule<{}>[] = [];

  // Always create at least one Shield rule
  for (const opt of [options ?? {}, ...additionalOptions]) {
    const mode = opt.mode === "LIVE" ? "LIVE" : "DRY_RUN";
    rules.push({
      type: "SHIELD",
      priority: Priority.Shield,
      mode,
    });
  }

  return rules;
}

export type ProtectSignupOptions<Characteristics extends string[]> = {
  rateLimit?:
    | SlidingWindowRateLimitOptions<Characteristics>
    | SlidingWindowRateLimitOptions<Characteristics>[];
  bots?: BotOptions | BotOptions[];
  email?: EmailOptions | EmailOptions[];
};

export function protectSignup<const Characteristics extends string[] = []>(
  options?: ProtectSignupOptions<Characteristics>,
): Product<
  Simplify<
    UnionToIntersection<
      { email: string } | CharacteristicProps<Characteristics>
    >
  >
> {
  let rateLimitRules: Primitive<{}> = [];
  if (Array.isArray(options?.rateLimit)) {
    rateLimitRules = slidingWindow(...options.rateLimit);
  } else {
    rateLimitRules = slidingWindow(options?.rateLimit);
  }

  let botRules: Primitive<{}> = [];
  if (Array.isArray(options?.bots)) {
    botRules = detectBot(...options.bots);
  } else {
    botRules = detectBot(options?.bots);
  }

  let emailRules: Primitive<{ email: string }> = [];
  if (Array.isArray(options?.email)) {
    emailRules = validateEmail(...options.email);
  } else {
    emailRules = validateEmail(options?.email);
  }

  return [...rateLimitRules, ...botRules, ...emailRules];
}

export interface ArcjetOptions<
  Rules extends [...(Primitive | Product)[]],
  Characteristics extends readonly string[],
> {
  /**
   * The API key to identify the site in Arcjet.
   */
  key: string;
  /**
   * Rules to apply when protecting a request.
   */
  rules: readonly [...Rules];
  /**
   * Characteristics to be used to uniquely identify clients.
   */
  characteristics?: Characteristics;
  /**
   * The client used to make requests to the Arcjet API. This must be set
   * when creating the SDK, such as inside @arcjet/next or mocked in tests.
   */
  client?: Client;
  /**
   * The logger used to emit useful information from the SDK.
   */
  log?: ArcjetLogger;
}

/**
 * The Arcjet client provides a public `protect()` method to
 * make a decision about how a request should be handled.
 */
export interface Arcjet<Props extends PlainObject> {
  /**
   * Make a decision about how to handle a request. This will analyze the
   * request locally where possible and call the Arcjet decision API.
   *
   * @param {ArcjetAdapterContext} ctx - Additional context for this function call.
   * @param {ArcjetRequest} request - Details about the {@link ArcjetRequest} that Arcjet needs to make a decision.
   * @returns An {@link ArcjetDecision} indicating Arcjet's decision about the request.
   */
  protect(
    ctx: ArcjetAdapterContext,
    request: ArcjetRequest<Props>,
  ): Promise<ArcjetDecision>;

  /**
   * Augments the client with another rule. Useful for varying rules based on
   * criteria in your handler—e.g. different rate limit for logged in users.
   *
   * @param rule The rule to add to this execution.
   * @returns An augmented {@link Arcjet} client.
   */
  withRule<Rule extends Primitive | Product>(
    rule: Rule,
  ): Arcjet<Simplify<Props & ExtraProps<Rule>>>;
}

/**
 * Create a new Arcjet client with the specified {@link ArcjetOptions}.
 *
 * @param options {ArcjetOptions} Arcjet configuration options.
 */
export default function arcjet<
  const Rules extends [...(Primitive | Product)[]] = [],
  const Characteristics extends readonly string[] = [],
>(
  options: ArcjetOptions<Rules, Characteristics>,
): Arcjet<Simplify<ExtraProps<Rules> & CharacteristicProps<Characteristics>>> {
  // We destructure here to make the function signature neat when viewed by consumers
  const { key, rules } = options;

  const rt = runtime();

  // TODO: Separate the ArcjetOptions from the SDK Options
  // It is currently optional in the options so users can override it via an SDK
  if (typeof options.log === "undefined") {
    throw new Error("Log is required");
  }
  const log = options.log;

  // TODO(#207): Remove this when we can default the transport so client is not required
  // It is currently optional in the options so the Next SDK can override it for the user
  if (typeof options.client === "undefined") {
    throw new Error("Client is required");
  }
  const client = options.client;

  // A local cache of block decisions. Might be emphemeral per request,
  // depending on the way the runtime works, but it's worth a try.
  // TODO(#132): Support configurable caching
  const blockCache = new Cache<ArcjetReason>();

  const rootRules: ArcjetRule[] = rules
    .flat(1)
    .sort((a, b) => a.priority - b.priority);

  async function protect<Props extends PlainObject>(
    rules: ArcjetRule[],
    ctx: ArcjetAdapterContext,
    request: ArcjetRequest<Props>,
  ) {
    // This goes against the type definition above, but users might call
    // `protect()` with no value and we don't want to crash
    if (typeof request === "undefined") {
      request = {} as typeof request;
    }

    const details: Partial<ArcjetRequestDetails> = Object.freeze({
      ip: request.ip,
      method: request.method,
      protocol: request.protocol,
      host: request.host,
      path: request.path,
      headers: new ArcjetHeaders(request.headers),
      cookies: request.cookies,
      query: request.query,
      // TODO(#208): Re-add body
      // body: request.body,
      extra: extraProps(request),
      email: typeof request.email === "string" ? request.email : undefined,
    });

    log.time?.("local");

    log.time?.("fingerprint");

    const characteristics = options.characteristics
      ? [...options.characteristics]
      : [];

    const baseContext = {
      key,
      log,
      characteristics,
      ...ctx,
    };

    const fingerprint = await analyze.generateFingerprint(
      baseContext,
      toAnalyzeRequest(details),
    );
    log.debug("fingerprint (%s): %s", rt, fingerprint);
    log.timeEnd?.("fingerprint");

    const context: ArcjetContext = Object.freeze({
      ...baseContext,
      fingerprint,
      runtime: rt,
    });

    if (rules.length < 1) {
      // TODO(#607): Error if no rules configured after deprecation period
      log.warn(
        "Calling `protect()` with no rules is deprecated. Did you mean to configure the Shield rule?",
      );
    }

    if (rules.length > 10) {
      log.error("Failure running rules. Only 10 rules may be specified.");

      const decision = new ArcjetErrorDecision({
        ttl: 0,
        reason: new ArcjetErrorReason("Only 10 rules may be specified"),
        // No results because the sorted rules were too long and we don't want
        // to instantiate a ton of NOT_RUN results
        results: [],
      });

      client.report(
        context,
        details,
        decision,
        // No rules because we've determined they were too long and we don't
        // want to try to send them to the server
        [],
      );

      return decision;
    }

    const results: ArcjetRuleResult[] = [];
    for (let idx = 0; idx < rules.length; idx++) {
      // Default all rules to NOT_RUN/ALLOW before doing anything
      results[idx] = new ArcjetRuleResult({
        ttl: 0,
        state: "NOT_RUN",
        conclusion: "ALLOW",
        reason: new ArcjetReason(),
      });

      // Add top-level characteristics to all Rate Limit rules that don't already have
      // their own set of characteristics.
      const candidate_rule = rules[idx];
      if (isRateLimitRule(candidate_rule)) {
        if (typeof candidate_rule.characteristics === "undefined") {
          candidate_rule.characteristics = characteristics;
          rules[idx] = candidate_rule;
        }
      }
    }

    // We have our own local cache which we check first. This doesn't work in
    // serverless environments where every request is isolated, but there may be
    // some instances where the instance is not recycled immediately. If so, we
    // can take advantage of that.
    log.time?.("cache");
    const existingBlockReason = blockCache.get(fingerprint);
    log.timeEnd?.("cache");

    // If already blocked then we can async log to the API and return the
    // decision immediately.
    if (existingBlockReason) {
      log.timeEnd?.("local");
      log.debug(
        {
          fingerprint,
          existingBlockReason,
        },
        "decide: alreadyBlocked",
      );
      const decision = new ArcjetDenyDecision({
        ttl: blockCache.ttl(fingerprint),
        reason: existingBlockReason,
        // All results will be NOT_RUN because we used a cached decision
        results,
      });

      client.report(context, details, decision, rules);

      log.debug(
        {
          id: decision.id,
          conclusion: decision.conclusion,
          fingerprint,
          reason: existingBlockReason,
          runtime: rt,
        },
        "decide: already blocked",
      );

      return decision;
    }

    for (const [idx, rule] of rules.entries()) {
      // This re-assignment is a workaround to a TypeScript error with
      // assertions where the name was introduced via a destructure
      let localRule: ArcjetLocalRule;
      if (isLocalRule(rule)) {
        localRule = rule;
      } else {
        continue;
      }

      log.time?.(rule.type);

      try {
        localRule.validate(context, details);
        results[idx] = await localRule.protect(context, details);

        log.debug(
          {
            id: results[idx].ruleId,
            rule: rule.type,
            fingerprint,
            path: details.path,
            runtime: rt,
            ttl: results[idx].ttl,
            conclusion: results[idx].conclusion,
            reason: results[idx].reason,
          },
          "Local rule result:",
        );
      } catch (err) {
        log.error(
          "Failure running rule: %s due to %s",
          rule.type,
          errorMessage(err),
        );

        results[idx] = new ArcjetRuleResult({
          ttl: 0,
          state: "RUN",
          conclusion: "ERROR",
          reason: new ArcjetErrorReason(err),
        });
      }

      log.timeEnd?.(rule.type);

      if (results[idx].isDenied()) {
        log.timeEnd?.("local");

        const decision = new ArcjetDenyDecision({
          ttl: results[idx].ttl,
          reason: results[idx].reason,
          results,
        });

        // Only a DENY decision is reported to avoid creating 2 entries for a
        // request. Upon ALLOW, the `decide` call will create an entry for the
        // request.
        client.report(context, details, decision, rules);

        // If we're not in DRY_RUN mode, we want to cache non-zero TTL results
        // and return this DENY decision.
        if (rule.mode !== "DRY_RUN") {
          if (results[idx].ttl > 0) {
            log.debug(
              {
                fingerprint,
                conclusion: decision.conclusion,
                reason: decision.reason,
              },
              "Caching decision for %d seconds",
              decision.ttl,
            );

            blockCache.set(
              fingerprint,
              decision.reason,
              nowInSeconds() + decision.ttl,
            );
          }

          return decision;
        }

        log.warn(
          `Dry run mode is enabled for "%s" rule. Overriding decision. Decision was: %s`,
          rule.type,
          decision.conclusion,
        );
      }
    }

    log.timeEnd?.("local");
    log.time?.("remote");

    // With no cached values, we take a decision remotely. We use a timeout to
    // fail open.
    try {
      log.time?.("decideApi");
      const decision = await client.decide(context, details, rules);
      log.timeEnd?.("decideApi");

      // If the decision is to block and we have a non-zero TTL, we cache the
      // block locally
      if (decision.isDenied() && decision.ttl > 0) {
        log.debug("decide: Caching block locally for %d seconds", decision.ttl);

        blockCache.set(
          fingerprint,
          decision.reason,
          nowInSeconds() + decision.ttl,
        );
      }

      return decision;
    } catch (err) {
      log.error(
        "Encountered problem getting remote decision: %s",
        errorMessage(err),
      );
      const decision = new ArcjetErrorDecision({
        ttl: 0,
        reason: new ArcjetErrorReason(err),
        results,
      });

      client.report(context, details, decision, rules);

      return decision;
    } finally {
      log.timeEnd?.("remote");
    }
  }

  // This is a separate function so it can be called recursively
  function withRule<Rule extends Primitive | Product>(
    baseRules: ArcjetRule[],
    rule: Rule,
  ) {
    const rules = [...baseRules, ...rule].sort(
      (a, b) => a.priority - b.priority,
    );

    return Object.freeze({
      withRule(rule: Primitive | Product) {
        return withRule(rules, rule);
      },
      async protect(
        ctx: ArcjetAdapterContext,
        request: ArcjetRequest<ExtraProps<typeof rules>>,
      ): Promise<ArcjetDecision> {
        return protect(rules, ctx, request);
      },
    });
  }

  return Object.freeze({
    withRule(rule: Primitive | Product) {
      return withRule(rootRules, rule);
    },
    async protect(
      ctx: ArcjetAdapterContext,
      request: ArcjetRequest<ExtraProps<typeof rootRules>>,
    ): Promise<ArcjetDecision> {
      return protect(rootRules, ctx, request);
    },
  });
}
