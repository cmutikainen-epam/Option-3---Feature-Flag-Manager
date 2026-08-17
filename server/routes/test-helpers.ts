import { Cause, type Exit, Option } from "effect";

/** The `_tag` of a failed Effect's error, or `undefined` if it succeeded. */
export const failureTag = (exit: Exit.Exit<unknown, { _tag: string }>): string | undefined => {
  if (exit._tag !== "Failure") return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : undefined;
};
