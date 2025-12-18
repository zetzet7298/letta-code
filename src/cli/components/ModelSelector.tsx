// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import { colors } from "./colors";

import { getDynamicModels, type UiModel } from "../../agent/customModels";

// type UiModel moved to src/agent/customModels.ts

interface ModelSelectorProps {
  currentModel?: string;
  currentEnableReasoner?: boolean;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

export function ModelSelector({
  currentModel,
  currentEnableReasoner,
  onSelect,
  onCancel,
}: ModelSelectorProps) {
  const typedModels = models as UiModel[];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [startIndex, setStartIndex] = useState(0);
  // undefined: not loaded yet (show spinner)
  // Set<string>: loaded and filtered
  // null: error fallback (show all models + warning)
  const [availableModels, setAvailableModels] = useState<
    Set<string> | null | undefined
  >(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch available models from the API (with caching + inflight dedupe)
  const loadModels = useRef(async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        clearAvailableModelsCache();
        if (mountedRef.current) {
          setRefreshing(true);
          setError(null);
        }
      }

      const cacheInfoBefore = getAvailableModelsCacheInfo();
      const result = await getAvailableModelHandles({ forceRefresh });

      if (!mountedRef.current) return;

      setAvailableModels(result.handles);
      setIsCached(!forceRefresh && cacheInfoBefore.isFresh);
      setIsLoading(false);
      setRefreshing(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load models");
      setIsLoading(false);
      setRefreshing(false);
      // Fallback: show all models if API fails
      setAvailableModels(null);
    }
  });

  useEffect(() => {
    loadModels.current(false);
  }, []);

  // Filter models based on availability
  const filteredModels = useMemo(() => {
    // Not loaded yet: render nothing (avoid briefly showing unfiltered models)
    if (availableModels === undefined) return [];
    // Error fallback: show all models with warning
    if (availableModels === null) return typedModels;
    // Loaded: filter to only show models the user has access to
    const knownModels = typedModels.filter((model) => availableModels.has(model.handle));
    const knownHandles = new Set(knownModels.map((m) => m.handle));

    // Get dynamic models using isolated logic
    const dynamicModels = getDynamicModels(availableModels, knownHandles);

    // Dynamic models from config should likely come FIRST if configured, or user preference.
    // For now, appending dynamic models after standard ones, OR we can sort everything.
    // But usually standard models (models.json) are "featured".
    return [...knownModels, ...dynamicModels];
  }, [typedModels, availableModels]);

  const VISIBLE_COUNT = 10;

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && filteredModels.length > 0) {
      const index = filteredModels.findIndex((m) => m.handle === currentModel);
      if (index >= 0) {
        setSelectedIndex(index);
        // Center initial view if possible
        if (index > VISIBLE_COUNT - 1) {
          setStartIndex(Math.max(0, index - Math.floor(VISIBLE_COUNT / 2)));
        }
      }
      initializedRef.current = true;
    }
  }, [filteredModels, currentModel]);

  const visibleModels = useMemo(() => {
    return filteredModels.slice(startIndex, startIndex + VISIBLE_COUNT);
  }, [filteredModels, startIndex]);

  const totalItems = filteredModels.length;

  useInput(
    (input, key) => {
      // Allow ESC even while loading
      if (key.escape) {
        onCancel();
        return;
      }

      // Allow 'r' to refresh even while loading (but not while already refreshing)
      if (input === "r" && !refreshing) {
        loadModels.current(true);
        return;
      }

      // Disable other inputs while loading
      if (isLoading || refreshing || filteredModels.length === 0) {
        return;
      }

      if (key.upArrow) {
        const nextIndex = Math.max(0, selectedIndex - 1);
        setSelectedIndex(nextIndex);
        if (nextIndex < startIndex) {
          setStartIndex(nextIndex);
        }
      } else if (key.downArrow) {
        const nextIndex = Math.min(totalItems - 1, selectedIndex + 1);
        setSelectedIndex(nextIndex);
        if (nextIndex >= startIndex + VISIBLE_COUNT) {
          setStartIndex(nextIndex - VISIBLE_COUNT + 1);
        }
      } else if (key.return) {
        const selectedModel = filteredModels[selectedIndex];
        if (selectedModel) {
          onSelect(selectedModel.id);
        }
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Select Model (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
        {!isLoading && !refreshing && (
          <Text dimColor>
            {isCached
              ? "Cached models (press 'r' to refresh)"
              : "Press 'r' to refresh"}
          </Text>
        )}
      </Box>

      {isLoading && (
        <Box>
          <Text dimColor>Loading available models...</Text>
        </Box>
      )}

      {refreshing && (
        <Box>
          <Text dimColor>Refreshing models...</Text>
        </Box>
      )}

      {error && (
        <Box>
          <Text color="yellow">
            Warning: Could not fetch available models. Showing all models.
          </Text>
        </Box>
      )}

      {!isLoading && filteredModels.length === 0 && (
        <Box>
          <Text color="red">
            No models available. Please check your Letta configuration.
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {startIndex > 0 && <Text dimColor>... {startIndex} more above ...</Text>}
        {visibleModels.map((model, index) => {
          // Calculate absolute index in the filtered list
          const absoluteIndex = startIndex + index;
          const isSelected = absoluteIndex === selectedIndex;

          // Check if this model is current by comparing handle and relevant settings
          let isCurrent = model.handle === currentModel;
          // Simplified check for display purposes
          if (isCurrent && model.handle?.startsWith("anthropic/")) {
            // Keep old logic if needed or skip for simplicity in list view
            const modelEnableReasoner = model.updateArgs?.enable_reasoner;
            if (modelEnableReasoner !== undefined) {
              isCurrent = isCurrent && modelEnableReasoner === currentEnableReasoner;
            } else {
              isCurrent = isCurrent && currentEnableReasoner !== false;
            }
          }

          return (
            <Box key={model.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Box flexDirection="row">
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {model.label}
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Text>
                <Text dimColor> {model.description}</Text>
              </Box>
            </Box>
          );
        })}
        {filteredModels.length > startIndex + VISIBLE_COUNT && (
          <Text dimColor>... {filteredModels.length - (startIndex + VISIBLE_COUNT)} more below ...</Text>
        )}
      </Box>
    </Box>
  );
}
