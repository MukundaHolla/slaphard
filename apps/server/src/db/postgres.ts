export interface StatsRepository {
  // Phase 1: scaffold only. Account/stat persistence is implemented in later phases.
  saveMatchResult(_input: unknown): Promise<void>;
}

export class NoopStatsRepository implements StatsRepository {
  async saveMatchResult(_input: unknown): Promise<void> {
    return;
  }
}
