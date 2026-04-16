import React, { useState, useEffect, useCallback } from 'react';
import { CalendarIcon, PlusIcon } from 'lucide-react';

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

export function NotesSidebar({
  selectedDay,
  onSelectDay,
}: {
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
}) {
  const [days, setDays] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await window.notesAPI.listDays();
      setDays(list);
    } catch {
      setDays([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh the list when a transcription creates a new day file
  useEffect(() => {
    const cleanup = window.notesAPI.onTranscription((data) => {
      if (!days.includes(data.dayFile)) {
        refresh();
      }
    });
    return cleanup;
  }, [refresh, days]);

  const today = todayDateString();

  const handleTodayClick = useCallback(() => {
    onSelectDay(today);
  }, [onSelectDay, today]);

  return (
    <div className="scheduledTasksTab">
      <button className="threadListNewBtn" onClick={handleTodayClick}>
        <PlusIcon style={{ width: 16, height: 16 }} />
        Today
      </button>
      {loading && days.length === 0 ? (
        <div className="scheduledTasksEmpty">Loading...</div>
      ) : days.length === 0 ? (
        <div className="scheduledTasksEmpty">No notes yet. Start recording!</div>
      ) : (
        <div className="scheduledTasksList">
          {days.map((day) => (
            <div
              key={day}
              className={`scheduledTasksItem ${selectedDay === day ? 'scheduledTasksItem--active' : ''}`}
              onClick={() => onSelectDay(day)}
            >
              <div className="scheduledTasksItemContent">
                <CalendarIcon style={{ width: 16, height: 16, flexShrink: 0 }} />
                <div className="scheduledTasksItemText">
                  <span className="scheduledTasksItemName">
                    {day === today ? 'Today' : formatDayLabel(day)}
                  </span>
                  <span className="scheduledTasksItemSchedule">{day}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
