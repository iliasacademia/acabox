import React, { useState, useEffect } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { Select, SelectTrigger, SelectValue, SelectContent } from './ui/select';
import { Select as SelectPrimitive } from 'radix-ui';

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Most capable for ambitious work' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Most efficient for everyday tasks' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
] as const;

const STORAGE_KEY = 'selectedModel';
const DEFAULT_MODEL = 'claude-opus-4-6';

export const ModelSelector: React.FC = () => {
  const [model, setModel] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_MODEL,
  );
  const runtime = useAssistantRuntime();

  useEffect(() => {
    return runtime.registerModelContextProvider({
      getModelContext: () => ({
        config: { modelName: model },
      }),
    });
  }, [runtime, model]);

  const handleChange = (value: string) => {
    setModel(value);
    localStorage.setItem(STORAGE_KEY, value);
  };

  const selectedLabel = MODELS.find((m) => m.id === model)?.label ?? 'Sonnet 4.6';

  return (
    <Select value={model} onValueChange={handleChange}>
      <SelectTrigger className="modelSelectorTrigger">
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent className="modelSelectorContent">
        {MODELS.map((m) => (
          <SelectPrimitive.Item key={m.id} value={m.id} className="modelSelectorItem">
            <div className="modelSelectorItemInner">
              <span className="modelSelectorItemLabel">
                <SelectPrimitive.ItemText>{m.label}</SelectPrimitive.ItemText>
              </span>
              <span className="modelSelectorItemDescription">{m.description}</span>
            </div>
          </SelectPrimitive.Item>
        ))}
      </SelectContent>
    </Select>
  );
};
