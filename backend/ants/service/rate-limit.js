/**
 * Token bucket: `take(n)` resolves once `n` tokens are available, refilling
 * `perSecond` tokens up to `burst`. Callers are served in arrival order so a
 * large request cannot starve behind a stream of small ones.
 */
export class TokenBucket {
    perSecond;
    burst;
    now;
    tokens;
    lastRefill;
    queue = Promise.resolve();
    constructor(perSecond, burst, now = Date.now) {
        this.perSecond = perSecond;
        this.burst = burst;
        this.now = now;
        this.tokens = burst;
        this.lastRefill = now();
    }
    take(count = 1) {
        const turn = this.queue.then(() => this.wait(Math.min(count, this.burst)));
        this.queue = turn.catch(() => undefined);
        return turn;
    }
    async wait(count) {
        for (;;) {
            this.refill();
            if (this.tokens >= count) {
                this.tokens -= count;
                return;
            }
            const deficit = count - this.tokens;
            await new Promise((resolve) => setTimeout(resolve, Math.ceil(deficit / this.perSecond * 1000)));
        }
    }
    refill() {
        const at = this.now();
        this.tokens = Math.min(this.burst, this.tokens + (at - this.lastRefill) / 1000 * this.perSecond);
        this.lastRefill = at;
    }
}
//# sourceMappingURL=rate-limit.js.map