import React, { useId } from "react";
import { useFormMemory } from "@/hooks/useFormMemory";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";

export interface MemoryInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  memoryKey: string;
  /** Maximum number of remembered values (default: 10) */
  memoryMax?: number;
}

export const MemoryInput = React.forwardRef<
  HTMLInputElement,
  MemoryInputProps
>(function MemoryInput(
  { memoryKey, memoryMax, onBlur, ...inputProps },
  ref
) {
  const enabled = useFeatureFlag("form_memory");
  const { suggestions, remember } = useFormMemory(memoryKey, memoryMax);
  const listId = useId();

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (enabled) {
      remember(e.target.value);
    }
    onBlur?.(e);
  };

  if (!enabled) {
    return <input ref={ref} onBlur={onBlur} {...inputProps} />;
  }

  return (
    <>
      <input
        ref={ref}
        list={listId}
        onBlur={handleBlur}
        {...inputProps}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
});

MemoryInput.displayName = "MemoryInput";
