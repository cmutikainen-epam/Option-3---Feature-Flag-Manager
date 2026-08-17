import { EventEmitter } from "node:events";

/** TODO create a new event 'FlagRowChanged' and send row id to allow finer grained updates
 *  This will become necessary as the list of feature flags grows
 */
const FlagsTableChanged = "flagsTableChanged" as const;
const FlagsEventEmitter = new EventEmitter<{ [FlagsTableChanged]: [timestamp: Date] }>();

const emitTableChange = (timestamp: Date) => FlagsEventEmitter.emit(FlagsTableChanged, timestamp);
const onTableChange = (listener: (timestamp: Date) => void) => {
  FlagsEventEmitter.on(FlagsTableChanged, (timestamp) => {
    listener(timestamp);
  });

  return () => FlagsEventEmitter.off(FlagsTableChanged, listener);
};

export const FlagsEventBus = {
  emitTableChange,
  onTableChange,
};
