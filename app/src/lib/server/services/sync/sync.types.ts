export interface SyncEvent {
  /** Deterministic event ID for Google Calendar ([a-v0-9]{5,1024}) */
  id: string;
  sessionKey: string;
  courseId: string;
  title: string;
  description: string;
  startDateTime: string; // ISO 8601
  endDateTime: string;   // ISO 8601
  timeZone: string;
  contentHash: string;
}

export interface ReconciliationStats {
  totalDesired: number;
  created: number;
  updated: number;
  unchanged: number;
  deletedObsolete: number;
  failed: number;
}

export interface SyncResult {
  success: boolean;
  provider: 'google' | 'arc';
  courseId: string;
  calendarId: string;
  stats: ReconciliationStats;
  syncedAt: string;
  errors?: Array<{ eventId: string; error: string }>;
  message: string;
}

export interface TargetCalendar {
  id: string;
  name: string;
  primary: boolean;
}

export interface ProviderAuthStatus {
  connected: boolean;
  provider: 'google' | 'arc';
  accountEmail?: string;
  expiresAt?: string;
  calendars?: TargetCalendar[];
  endpoint?: string;
  hasCredentials?: boolean;
  clientId?: string;
}

export interface ScheduleSyncProvider {
  readonly id: 'google' | 'arc';
  readonly name: string;
  getAuthStatus(): Promise<ProviderAuthStatus>;
  listCalendars(): Promise<TargetCalendar[]>;
  reconcileSchedule(courseId: string, calendarId: string, options?: { defaultTime?: string }): Promise<SyncResult>;
  cleanupCourseEvents(courseId: string, calendarId?: string): Promise<{ deleted: number }>;
}
