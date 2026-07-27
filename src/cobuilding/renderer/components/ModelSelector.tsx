import React, { useState, useEffect } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import { MSymbol } from './command-desk/MSymbol';

const MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Highest intelligence, premium cost' },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Most capable for ambitious work' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Previous-generation Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Most efficient for everyday tasks' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
] as const;

// Thinking-level dial. Values are the Claude Agent SDK `effort` levels
// (query() option); labels mirror the Claude Desktop app ("Extra" == 'xhigh').
// Effort works alongside adaptive thinking to guide reasoning depth.
export type EffortId = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: { id: EffortId; label: string; note?: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra' },
  // 'max' is only honored on the most capable models (e.g. the Opus tier);
  // lighter models fall back to their top supported level.
  { id: 'max', label: 'Max', note: 'Best on the most capable models' },
];

const MODEL_KEY = 'selectedModel';
const EFFORT_KEY = 'selectedEffort';
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_EFFORT: EffortId = 'high';

function readModel(): string {
  // Stored value may reference a model removed from the list; fall back.
  const stored = localStorage.getItem(MODEL_KEY);
  return stored && MODELS.some((m) => m.id === stored) ? stored : DEFAULT_MODEL;
}

function readEffort(): EffortId {
  const stored = localStorage.getItem(EFFORT_KEY) as EffortId | null;
  return stored && EFFORTS.some((e) => e.id === stored) ? stored : DEFAULT_EFFORT;
}

/**
 * Display label for a model id. Ids come from two places: this picker, and the
 * Agent SDK's init event (what it actually resolved), which can name a model
 * that isn't in the list above — a snapshot id, or one dropped from the picker.
 * Those fall back to the raw id so the header never claims the wrong model.
 */
export function formatModelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Display label for an effort id; unknown values pass through unchanged. */
export function formatEffortLabel(id: string): string {
  return EFFORTS.find((e) => e.id === id)?.label ?? id;
}

/** Display label of the currently selected model (for mono header metas). */
export function getSelectedModelLabel(): string {
  return formatModelLabel(readModel());
}

/** Selected model id — read at send time by the chat adapter. */
export function getSelectedModel(): string {
  return readModel();
}

/** Selected effort id — read at send time by the chat adapter. */
export function getSelectedEffort(): EffortId {
  return readEffort();
}

/** Display label of the currently selected effort level. */
export function getSelectedEffortLabel(): string {
  const id = readEffort();
  return EFFORTS.find((e) => e.id === id)?.label ?? 'High';
}

export const ModelSelector: React.FC = () => {
  const [model, setModel] = useState(readModel);
  const [effort, setEffort] = useState<EffortId>(readEffort);
  const runtime = useAssistantRuntime();

  // Model rides to the agent via the assistant-ui model context (read as
  // context.config.modelName in chatAdapter). Effort is read from localStorage
  // at send time via getSelectedEffort() instead.
  useEffect(() => {
    return runtime.registerModelContextProvider({
      getModelContext: () => ({
        config: { modelName: model },
      }),
    });
  }, [runtime, model]);

  const changeModel = (value: string) => {
    setModel(value);
    localStorage.setItem(MODEL_KEY, value);
    window.dispatchEvent(new CustomEvent('cd:model-changed'));
  };

  const changeEffort = (value: string) => {
    const next = value as EffortId;
    setEffort(next);
    localStorage.setItem(EFFORT_KEY, next);
    window.dispatchEvent(new CustomEvent('cd:effort-changed'));
  };

  const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[1];
  const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[2];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="modelSelectorTrigger" aria-label="Model and effort">
          <span className="modelSelectorTriggerModel">{currentModel.label}</span>
          <span className="modelSelectorTriggerEffort">{currentEffort.label}</span>
          <MSymbol name="expand_more" size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="modelMenuContent" align="end" side="top" sideOffset={6}>
          {/* Currently selected model, shown prominently (matches desktop). */}
          <div className="modelMenuCurrent">
            <span className="modelMenuCurrentText">
              <span className="modelMenuCurrentLabel">{currentModel.label}</span>
              <span className="modelMenuItemDesc">{currentModel.description}</span>
            </span>
            <MSymbol name="check" size={18} className="modelMenuCheck" />
          </div>

          <DropdownMenu.Separator className="modelMenuSep" />

          {/* Effort submenu */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="modelMenuItem modelMenuSubTrigger">
              <span className="modelMenuItemLabel">Effort</span>
              <span className="modelMenuItemRight">
                <span className="modelMenuValue">{currentEffort.label}</span>
                <MSymbol name="chevron_right" size={18} />
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="modelMenuContent modelMenuWide" sideOffset={4} alignOffset={-4}>
                <div className="modelMenuBlurb">
                  Higher effort means more thorough responses, but takes longer and uses your limits faster.
                </div>
                <DropdownMenu.RadioGroup value={effort} onValueChange={changeEffort}>
                  {EFFORTS.map((e) => (
                    <DropdownMenu.RadioItem key={e.id} value={e.id} className="modelMenuItem modelMenuRadio">
                      <span className="modelMenuItemLabel">
                        {e.label}
                        {e.id === DEFAULT_EFFORT && <span className="modelMenuBadge">Default</span>}
                        {e.note && (
                          <span className="modelMenuInfo" title={e.note}>
                            <MSymbol name="info" size={14} />
                          </span>
                        )}
                      </span>
                      <DropdownMenu.ItemIndicator className="modelMenuIndicator">
                        <MSymbol name="check" size={18} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          {/* More models submenu */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="modelMenuItem modelMenuSubTrigger">
              <span className="modelMenuItemLabel">More models</span>
              <span className="modelMenuItemRight">
                <MSymbol name="chevron_right" size={18} />
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="modelMenuContent modelMenuWide" sideOffset={4} alignOffset={-4}>
                <DropdownMenu.RadioGroup value={model} onValueChange={changeModel}>
                  {MODELS.map((m) => (
                    <DropdownMenu.RadioItem
                      key={m.id}
                      value={m.id}
                      className="modelMenuItem modelMenuRadio modelMenuModelItem"
                    >
                      <span className="modelMenuModelText">
                        <span className="modelMenuItemLabel">{m.label}</span>
                        <span className="modelMenuItemDesc">{m.description}</span>
                      </span>
                      <DropdownMenu.ItemIndicator className="modelMenuIndicator">
                        <MSymbol name="check" size={18} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
