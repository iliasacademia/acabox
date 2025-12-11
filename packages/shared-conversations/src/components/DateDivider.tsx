import React from 'react';

interface DateDividerProps {
  date: string;
}

export function DateDivider({ date }: DateDividerProps) {
  return (
    <div className="dateDivider">
      <div className="dateDividerLine" />
      <span className="dateDividerText">{date}</span>
      <div className="dateDividerLine" />
    </div>
  );
}
