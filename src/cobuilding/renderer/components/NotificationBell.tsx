import React, { useState, useEffect, useRef } from 'react';
import { BellIcon } from 'lucide-react';

export function NotificationBell({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refresh = () => {
      window.notificationsAPI.unreadCount().then(setUnreadCount);
    };
    refresh();
    return window.briefingsAPI.onChanged(refresh);
  }, []);

  useEffect(() => {
    if (isOpen) {
      window.notificationsAPI.list().then(setNotifications);
      if (unreadCount > 0) {
        window.notificationsAPI.markAllAsRead();
        setUnreadCount(0);
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const handleMarkAllRead = () => {
    window.notificationsAPI.markAllAsRead();
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
  };

  const handleNotificationClick = () => {
    setIsOpen(false);
    onNavigateHome();
  };

  return (
    <div className="notificationBell__wrapper" ref={wrapperRef}>
      <button className="notificationBell" onClick={() => setIsOpen(!isOpen)}>
        <BellIcon size={18} />
        {unreadCount > 0 && (
          <span className="notificationBell__badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="notificationBell__dropdown">
          <div className="notificationBell__header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button className="notificationBell__markAll" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          <div className="notificationBell__list">
            {notifications.length === 0 ? (
              <div className="notificationBell__empty">No notifications</div>
            ) : (
              notifications.map(n => (
                <button
                  key={n.id}
                  className={`notificationBell__item${!n.read_at ? ' notificationBell__item--unread' : ''}`}
                  onClick={handleNotificationClick}
                >
                  <div className="notificationBell__itemTitle">{n.title}</div>
                  {n.body && <div className="notificationBell__itemBody">{n.body}</div>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
