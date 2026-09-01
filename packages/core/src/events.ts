/** Domain event DTO emitted by Core without transport or presentation fields. */
export interface CoreEvent {
  readonly type: string;
  readonly at: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Event sink port implemented by Plugin, a service, or a test. */
export interface CoreEventSink {
  readonly emit: (event: CoreEvent) => void;
}
