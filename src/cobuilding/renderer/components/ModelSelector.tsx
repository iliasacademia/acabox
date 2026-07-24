import React, { useState, useEffect } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { Select, SelectTrigger, SelectValue, SelectContent } from './ui/select';
import { Select as SelectPrimitive } from 'radix-ui';

const MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Highest intelligence, premium cost' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable for ambitious work' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Most efficient for everyday tasks' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
] as const;

const STORAGE_KEY = 'selectedModel';
const DEFAULT_MODEL = 'claude-opus-4-8';

/** Display label of the currently selected model (for mono header metas). */
export function getSelectedModelLabel(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  const model = stored && MODELS.some((m) => m.id === stored) ? stored : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === model)?.label ?? 'Opus 4.8';
}

export const ModelSelector: React.FC = () => {
  const [model, setModel] = useState(() => {
    // Stored value may reference a model removed from the list; fall back.
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && MODELS.some((m) => m.id === stored) ? stored : DEFAULT_MODEL;
  });
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
    window.dispatchEvent(new CustomEvent('cd:model-changed'));
  };

  const selectedLabel = MODELS.find((m) => m.id === model)?.label ?? 'Opus 4.8';

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
