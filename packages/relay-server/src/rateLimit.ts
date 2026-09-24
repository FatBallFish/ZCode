/**
 * 最小令牌桶限频器（spec §6.5）。
 *
 * bind 与 WSS 升级按 IP 限频；失败按指数惩罚。全内存、无清理线程——
 * 调用方保证 key 空间有界（IP 数量受连接规模约束），桶随首次访问惰性创建。
 */

export class RateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; lastRefillAt: number; strikes: number }
  >();

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private bucket(key: string) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefillAt: this.now(), strikes: 0 };
      this.buckets.set(key, bucket);
    }
    // 整窗线性补币：不追踪边界，够用且无定时器。
    const elapsed = this.now() - bucket.lastRefillAt;
    if (elapsed > this.windowMs) {
      const refill = Math.floor(elapsed / this.windowMs) * this.maxTokens;
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refill);
      bucket.lastRefillAt += Math.floor(elapsed / this.windowMs) * this.windowMs;
    }
    return bucket;
  }

  /** 消耗 1 个令牌；不足返回 false。 */
  allow(key: string): boolean {
    const bucket = this.bucket(key);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** 失败惩罚：按 strike 次数指数放大消耗（1 次失败 = 2^strikes 个额外令牌）。 */
  strike(key: string): void {
    const bucket = this.bucket(key);
    bucket.strikes = Math.min(10, bucket.strikes + 1);
    bucket.tokens -= 2 ** bucket.strikes;
  }

  /** 成功后衰减惩罚计数。 */
  resetStrikes(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.strikes = 0;
    }
  }
}
