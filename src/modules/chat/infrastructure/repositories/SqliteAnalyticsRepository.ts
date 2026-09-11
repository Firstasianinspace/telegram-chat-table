/**
 * SQLite-backed implementation of ChatAnalyticsRepository.
 *
 * Replaces the Dexie materialized-view tables (dailySenderCounts,
 * dailyHourlyCounts, senderTotalCounts) with plain SQL GROUP BY over the
 * `messages` table's derived columns (date_key/hour/day_of_week) — SQLite's
 * query planner makes a maintained materialized view unnecessary here; see
 * sqlite.worker.ts's analytics* handlers for the actual queries.
 */

import type {
  AnalyticsFilter,
  DateRange,
  SenderCount,
  DailyVolumePoint,
  HeatmapPoint,
  TimeSlotCount,
} from '../../application/queries/analyticsTypes';
import type { ChatAnalyticsRepository } from './AnalyticsRepository';
import type { SqliteWorkerClient } from '../sqlite/sqliteWorkerClient';

export class SqliteChatAnalyticsRepository implements ChatAnalyticsRepository {
  constructor(private readonly client: SqliteWorkerClient) { }

  async getTotalMessagesPerSender(filter?: AnalyticsFilter, limit: number = 20): Promise<SenderCount[]> {
    return this.client.analyticsTopSenders({ filter, limit });
  }

  async getDailyVolume(dateRange?: DateRange): Promise<DailyVolumePoint[]> {
    return this.client.analyticsDailyVolume({ dateRange });
  }

  async getWeeklyActivityHeatmap(dateRange?: DateRange): Promise<HeatmapPoint[]> {
    return this.client.analyticsHeatmap({ dateRange });
  }

  async getTimeOfDayDistribution(dateRange?: DateRange): Promise<TimeSlotCount[]> {
    return this.client.analyticsTimeOfDay({ dateRange });
  }
}
