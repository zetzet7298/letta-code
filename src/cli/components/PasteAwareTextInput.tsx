// Paste-aware text input wrapper that:
// 1. Detects large pastes (>5 lines or >500 chars) and replaces with placeholders
// 2. Supports image pasting (iTerm2 inline, data URLs, file paths, macOS clipboard)
// 3. Maintains separate display value (with placeholders) vs actual value (full content)
// 4. Resolves placeholders on submit

// Import useInput from vendored Ink for bracketed paste support
import { Text, useInput, useStdin } from "ink";

import { useEffect, useRef, useState } from "react";
import {
  translatePasteForImages,
  tryImportClipboardImageMac,
} from "../helpers/clipboard";
import { allocatePaste, resolvePlaceholders } from "../helpers/pasteRegistry";

interface PasteAwareTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  cursorPosition?: number;
  onCursorMove?: (position: number) => void;
}

function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length + 1;
}

/** Replace newlines with visual indicator for display */
function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "↵");
}

/** Find the boundary of the previous word for option+left navigation */
function findPreviousWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos === 0) return 0;

  // Move back one position if we're at the end of a word
  let pos = cursorPos - 1;

  // Skip whitespace backwards
  while (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos--;
  }

  // Skip word characters backwards
  while (pos > 0 && /\S/.test(text.charAt(pos))) {
    pos--;
  }

  // If we stopped at whitespace, move forward one
  if (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return Math.max(0, pos);
}

/** Find the boundary of the next word for option+right navigation */
function findNextWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos >= text.length) return text.length;

  let pos = cursorPos;

  // Skip current word forward
  while (pos < text.length && /\S/.test(text.charAt(pos))) {
    pos++;
  }

  // Skip whitespace forward
  while (pos < text.length && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return pos;
}

type WordDirection = "left" | "right";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_LEFT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)D$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_RIGHT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)C$/;

function detectOptionWordDirection(sequence: string): WordDirection | null {
  if (!sequence.startsWith("\u001b")) return null;
  if (sequence === "\u001bb" || sequence === "\u001bB") return "left";
  if (sequence === "\u001bf" || sequence === "\u001bF") return "right";
  if (OPTION_LEFT_PATTERN.test(sequence)) return "left";
  if (OPTION_RIGHT_PATTERN.test(sequence)) return "right";
  return null;
}

export function PasteAwareTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  cursorPosition,
  onCursorMove,
}: PasteAwareTextInputProps) {
  const { internal_eventEmitter } = useStdin();
  const [displayValue, setDisplayValue] = useState(value);
  // We don't strictly need actualValue state for the parent, but keeping it for logic consistency if needed later
  // mostly we just operate on displayValue and assume parent handles placeholder resolution
  // const [actualValue, setActualValue] = useState(value);

  const lastPasteDetectedAtRef = useRef<number>(0);
  const caretOffsetRef = useRef<number>((value || "").length);
  // Ref to track the authoritative value to handle rapid Unikey/IME inputs
  const valueRef = useRef(value);
  // Track last specific value we emitted to detect echoes
  const lastEmittedValueRef = useRef(value);

  const [nudgeCursorOffset, setNudgeCursorOffset] = useState<number | undefined>(undefined);

  // Sync prop value to internal state, but handle echoes smart
  useEffect(() => {
    if (value !== lastEmittedValueRef.current) {
      // External update (command history, clear, etc)
      valueRef.current = value;
      setDisplayValue(value);
      caretOffsetRef.current = value.length; // Default to end on external change usually
    }
  }, [value]);

  useEffect(() => {
    if (typeof cursorPosition === "number") {
      caretOffsetRef.current = cursorPosition;
      // Force re-render to show cursor move
      setDisplayValue(prev => prev);
    }
  }, [cursorPosition]);

  // Report cursor changes
  const updateCursor = (newPos: number) => {
    const clamped = Math.max(0, Math.min(newPos, valueRef.current.length));
    caretOffsetRef.current = clamped;
    if (onCursorMove) onCursorMove(clamped);
    // Force render
    setDisplayValue(prev => prev);
  };

  const updateValue = (newValue: string, newCursor?: number) => {
    valueRef.current = newValue;
    lastEmittedValueRef.current = newValue;
    setDisplayValue(newValue);
    onChange(newValue);

    if (newCursor !== undefined) {
      updateCursor(newCursor);
    }
  };

  const deleteCharacter = (forward: boolean) => {
    const current = valueRef.current;
    const pos = caretOffsetRef.current;

    if (forward) {
      // Delete key (forward)
      if (pos < current.length) {
        const next = current.slice(0, pos) + current.slice(pos + 1);
        updateValue(next, pos);
      }
    } else {
      // Backspace (backward)
      if (pos > 0) {
        const next = current.slice(0, pos - 1) + current.slice(pos);
        updateValue(next, pos - 1);
      }
    }
  };

  // Main Input Handler (replaces ink-text-input)
  useInput(
    (input, key) => {
      // Bracketed paste check
      const isPasted = (key as unknown as { isPasted?: boolean })?.isPasted;

      // 1. Handle Pastes (External logic or simple insertions)
      if (isPasted) {
        lastPasteDetectedAtRef.current = Date.now();
        const payload = typeof input === "string" ? input : "";
        let translated = translatePasteForImages(payload);
        if ((!translated || translated.length === 0) && payload.length === 0) {
          const clip = tryImportClipboardImageMac();
          if (clip) translated = clip;
        }

        if (translated && translated.length > 0) {
          handleInsert(translated, true); // true = raw insertion check
          return;
        }
      }

      // 2. Handle Paste Shortcuts
      if (
        (key.meta && (input === "v" || input === "V")) ||
        (key.ctrl && key.shift && (input === "v" || input === "V"))
      ) {
        const placeholder = tryImportClipboardImageMac();
        if (placeholder) {
          handleInsert(placeholder, true);
          return;
        }
        // fallthrough to let system handle or ignore?
      }

      // 3. Navigation / Special Keys
      if (key.return) {
        if (onSubmit) onSubmit(displayValue);
        return;
      }
      if (key.leftArrow) {
        updateCursor(caretOffsetRef.current - 1);
        return;
      }
      if (key.rightArrow) {
        updateCursor(caretOffsetRef.current + 1);
        return;
      }

      // Ignore modifiers
      if (key.ctrl || key.meta) return;

      // 4. Batch Stream Processing (Typing & IME)
      if (typeof input === "string" && input.length > 0) {
        let nextValue = valueRef.current;
        let nextPos = caretOffsetRef.current;
        let processed = false;

        // Heuristic for Unikey/IME:
        // If Ink detects a backspace key but the input string doesn't contain the raw code,
        // it means Ink separated them. Unikey sends Backspace + Char for correction.
        // We must apply the backspace FIRST.
        const hasRawBackspace = input.includes('\u0008') || input.includes('\u007F');
        if (key.backspace && !hasRawBackspace) {
          if (nextPos > 0) {
            nextValue = nextValue.slice(0, nextPos - 1) + nextValue.slice(nextPos);
            nextPos--;
            processed = true;
          }
        }

        for (let i = 0; i < input.length; i++) {
          const char = input[i] as string;
          const code = char.charCodeAt(0);

          if (code === 127 || code === 8) {
            // Backspace: Remove char before cursor
            if (nextPos > 0) {
              nextValue = nextValue.slice(0, nextPos - 1) + nextValue.slice(nextPos);
              nextPos--;
            }
            processed = true;
          } else if (code >= 32) {
            // Printable character: Insert at cursor
            nextValue = nextValue.slice(0, nextPos) + char + nextValue.slice(nextPos);
            nextPos++;
            processed = true;
          }
          // Ignore other control codes (<32)
        }

        if (processed) {
          updateValue(nextValue, nextPos);
          return;
        }
      }

      // 5. Fallback for Explicit Keys
      if (key.backspace) {
        deleteCharacter(false);
        return;
      }
      if (key.delete) {
        deleteCharacter(true);
        return;
      }
    },
    { isActive: focus }
  );


  const handleStringInsert = (text: string, isPaste: boolean) => {
    // Wrapper for existing handleInsert logic but renamed to avoid conflicts
    handleInsert(text, isPaste);
  };

  const handleInsert = (text: string, isPaste: boolean) => {
    const current = valueRef.current;
    const pos = caretOffsetRef.current;

    // Heuristic: Check fast large insertion if simpler logic didn't catch it
    const isLarge = isPaste || (text.length > 5);

    // Logic from original PasteAwareTextInput for handling large pastes/placeholders
    let insertion = text;
    let isComplexPaste = false;

    if (isLarge) {
      // Check image handling again? (Already done in isPasted block usually, but covers manual large input)
      // For brevity, assume clean text unless matched earlier
      const translated = translatePasteForImages(text); // idempotency check
      let lines = countLines(translated);

      if (text.length > 500 || lines > 5) {
        const pasteId = allocatePaste(translated);
        insertion = `[Pasted text #${pasteId} +${lines} lines]`;
        isComplexPaste = true;
      } else {
        insertion = sanitizeForDisplay(translated);
      }
    } else {
      // Sanitize simple input (newlines -> visual)
      insertion = sanitizeForDisplay(text);
    }

    const next = current.slice(0, pos) + insertion + current.slice(pos);
    updateValue(next, pos + insertion.length);
  };

  // Raw Input Handler for Option+Arrow / Option+Delete (copied logic)
  useEffect(() => {
    if (!internal_eventEmitter) return undefined;

    const moveCursorToPreviousWord = () => {
      const pos = findPreviousWordBoundary(valueRef.current, caretOffsetRef.current);
      updateCursor(pos);
    };

    const moveCursorToNextWord = () => {
      const pos = findNextWordBoundary(valueRef.current, caretOffsetRef.current);
      updateCursor(pos);
    };

    const deletePreviousWord = () => {
      const curPos = caretOffsetRef.current;
      const wordStart = findPreviousWordBoundary(valueRef.current, curPos);
      if (wordStart === curPos) return;

      const current = valueRef.current;
      const next = current.slice(0, wordStart) + current.slice(curPos);
      updateValue(next, wordStart);
    };

    const handleRawInput = (payload: unknown) => {
      if (!focus) return;
      let sequence: string | null = null;
      if (typeof payload === "string") sequence = payload;
      else if (typeof payload === "object" && (payload as any).sequence) sequence = (payload as any).sequence;

      if (!sequence) return;

      // Handle single backspace/DEL char (Unikey sends this separately)
      // This catches the case where Ink doesn't set key.backspace for DEL (127)
      if (sequence === "\x7f" || sequence === "\x08") {
        deleteCharacter(false);
        return;
      }

      if (
        sequence === "\x1b\x7f" ||
        sequence === "\x1b\x08" ||
        sequence === "\x1b\b" ||
        sequence === "\x17"
      ) {
        deletePreviousWord();
        return;
      }

      if (sequence.length <= 32 && sequence.includes("\u001b")) {
        const parts = sequence.split("\u001b");
        for (let i = 1; i < parts.length; i++) {
          const dir = detectOptionWordDirection(`\u001b${parts[i]}`);
          if (dir === "left") { moveCursorToPreviousWord(); return; }
          if (dir === "right") { moveCursorToNextWord(); return; }
        }
      }
    };

    internal_eventEmitter.prependListener("input", handleRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleRawInput);
    };
  }, [internal_eventEmitter, focus]); // Removed unnecessary deps

  // Rendering
  const cursorIndex = Math.min(Math.max(0, caretOffsetRef.current), displayValue.length);
  const beforeCursor = displayValue.slice(0, cursorIndex);
  // Default cursor char is space (' ') inverted, or the character being covered
  const cursorChar = displayValue[cursorIndex] || " ";
  const afterCursor = displayValue.slice(cursorIndex + 1);

  // If placeholder (empty value), render placeholder dimmed?
  const showPlaceholder = displayValue.length === 0 && placeholder;

  if (showPlaceholder) {
    return <Text dimColor>{placeholder}</Text>;
  }

  return (
    <Text>
      <Text>{beforeCursor}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text>{afterCursor}</Text>
    </Text>
  );
}
