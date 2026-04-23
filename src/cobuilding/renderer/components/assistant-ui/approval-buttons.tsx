import React, { useState } from 'react';
import type { FC } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import { CheckIcon } from 'lucide-react';

export const APPROVAL_CHOICES = ['Allow once', 'Always allow', 'Deny'] as const;

/** Recursively extract all text from a React node tree */
export function extractAllText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractAllText).join('');
  if (typeof node === 'object' && 'props' in (node as any)) {
    return extractAllText((node as any).props.children);
  }
  return '';
}

/** Checks if a React node tree contains an approval prompt pattern */
export function isApprovalContent(node: React.ReactNode): boolean {
  const text = extractAllText(node);
  return /allow once/i.test(text) && /always allow/i.test(text) && /deny/i.test(text);
}

/** Renders approval buttons for both <p> and <ul> elements containing approval choices */
export const ApprovalButtons: FC<{ children: React.ReactNode; tag?: 'p' | 'ul' }> = ({ children, tag }) => {
  const runtime = useAssistantRuntime();
  const [chosen, setChosen] = useState<string | null>(null);

  const isApprovalPrompt = isApprovalContent(children);

  if (!isApprovalPrompt) {
    const Tag = tag === 'ul' ? 'ul' : 'p';
    return <Tag>{children}</Tag>;
  }

  if (chosen) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', marginTop: '6px',
        fontSize: '13px', fontFamily: "'DM Sans', sans-serif",
        color: chosen === 'Deny' ? '#9ca3af' : '#16a34a',
      }}>
        <CheckIcon size={14} />
        <span>{chosen}</span>
      </div>
    );
  }

  const handleChoice = (choice: string) => {
    setChosen(choice);
    runtime.thread.append({
      role: 'user',
      content: [{ type: 'text', text: choice }],
    });
  };

  const btnBase: React.CSSProperties = {
    padding: '6px 16px', borderRadius: '8px', fontSize: '13px',
    fontFamily: "'DM Sans', sans-serif", fontWeight: 500, cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
      <button
        onClick={() => handleChoice('Allow once')}
        style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#374151' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
      >Allow once</button>
      <button
        onClick={() => handleChoice('Always allow')}
        style={{ ...btnBase, border: '1px solid #3b82f6', background: '#3b82f6', color: '#fff' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#2563eb')}
        onMouseLeave={e => (e.currentTarget.style.background = '#3b82f6')}
      >Always allow</button>
      <button
        onClick={() => handleChoice('Deny')}
        style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
      >Deny</button>
    </div>
  );
};

export const ApprovalParagraph: FC<{ children: React.ReactNode }> = ({ children }) => (
  <ApprovalButtons tag="p">{children}</ApprovalButtons>
);

export const ApprovalList: FC<{ children: React.ReactNode }> = ({ children }) => (
  <ApprovalButtons tag="ul">{children}</ApprovalButtons>
);
