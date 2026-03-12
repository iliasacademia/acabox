// Mock the window.electronAPI BEFORE importing analytics
// We need to extend the existing jsdom window, not replace it
const mockInvoke = jest.fn();
(window as any).electronAPI = {
  invoke: mockInvoke,
};

import { IPC_CHANNELS } from '../../../shared/types';
import * as analytics from '../analytics';

describe('Analytics Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  describe('Project Events', () => {
    it('should track projects list view', async () => {
      analytics.trackProjectsView();

      // Wait for async call
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'projects',
              action: 'view',
              source: 'desktop',
              metadata: {},
            },
          },
        },
      });
    });

    it('should track project click with project ID', async () => {
      const projectId = 123;
      analytics.trackProjectClick(projectId);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'project',
              action: 'click',
              source: 'desktop',
              metadata: {},
              project_id: projectId,
            },
          },
        },
      });
    });

    it('should track project view with project ID', async () => {
      const projectId = 456;
      analytics.trackProjectView(projectId);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'project',
              action: 'view',
              source: 'desktop',
              metadata: {},
              project_id: projectId,
            },
          },
        },
      });
    });
  });

  describe('Onboarding Events', () => {
    it('should track new project button click', async () => {
      analytics.trackNewProjectClick();

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'new_project',
              action: 'click',
              source: 'desktop',
              metadata: {},
            },
          },
        },
      });
    });

    it('should track project creation modal views', async () => {
      analytics.trackNewProjectModalView();

      await new Promise(resolve => setTimeout(resolve, 0));

      const firstCall = mockInvoke.mock.calls[0];
      expect(firstCall[1].data.arbitrary_event.data.event_name).toBe('new_project_modal');
      expect(firstCall[1].data.arbitrary_event.data.action).toBe('view');
    });

    it('should track create project completion', async () => {
      analytics.trackCreateProjectClick();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('create_project');
      expect(call[1].data.arbitrary_event.data.action).toBe('click');
    });
  });

  describe('Conversation Events', () => {
    it('should track conversation view with metadata', async () => {
      const projectId = 789;
      const conversationId = 123;
      const agentName = 'science_agent';

      analytics.trackConversationView(projectId, conversationId, agentName);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'conversation',
              action: 'view',
              source: 'desktop',
              metadata: {
                conversation_id: conversationId,
                agent_name: agentName,
              },
              project_id: projectId,
            },
          },
        },
      });
    });

    it('should track message sent', async () => {
      const projectId = 789;
      const conversationId = 456;
      const agentName = 'science_agent';

      analytics.trackConversationMessageSent(projectId, conversationId, agentName);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('conversation_message');
      expect(call[1].data.arbitrary_event.data.action).toBe('sent');
      expect(call[1].data.arbitrary_event.data.metadata.conversation_id).toBe(conversationId);
    });

    it('should track message received with duration', async () => {
      const projectId = 789;
      const conversationId = 456;
      const agentName = 'science_agent';
      const durationSeconds = 15;

      analytics.trackConversationMessageReceived(
        projectId,
        conversationId,
        agentName,
        durationSeconds
      );

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('conversation_message');
      expect(call[1].data.arbitrary_event.data.action).toBe('received');
      expect(call[1].data.arbitrary_event.data.metadata.duration_seconds).toBe(durationSeconds);
    });

    it('should track message received without duration', async () => {
      const projectId = 789;
      const conversationId = 456;
      const agentName = 'science_agent';

      analytics.trackConversationMessageReceived(projectId, conversationId, agentName);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.metadata.duration_seconds).toBeUndefined();
    });
  });

  describe('Notification Events', () => {
    it('should track notification view', async () => {
      const projectId = 111;
      const conversationId = 222;
      const agentName = 'science_agent';

      analytics.trackNotificationView(projectId, conversationId, agentName);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('notification');
      expect(call[1].data.arbitrary_event.data.action).toBe('view');
      expect(call[1].data.arbitrary_event.data.project_id).toBe(projectId);
    });

    it('should track notification click', async () => {
      const projectId = 111;
      const conversationId = 222;
      const agentName = 'science_agent';

      analytics.trackNotificationClick(projectId, conversationId, agentName);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('notification');
      expect(call[1].data.arbitrary_event.data.action).toBe('click');
    });
  });

  describe('Review Trigger Events', () => {
    it('should track full review trigger from desktop', async () => {
      const projectId = 333;
      const fileId = 444;

      analytics.trackTriggerFullReview('desktop', projectId, fileId);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'trigger_full_review',
              action: 'click',
              source: 'desktop',
              metadata: {
                file_id: fileId,
              },
              project_id: projectId,
            },
          },
        },
      });
    });

    it('should track diff review trigger from overlay', async () => {
      const projectId = 333;
      const fileId = 444;

      analytics.trackTriggerDiffReview('overlay', projectId, fileId);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('trigger_diff_review');
      expect(call[1].data.arbitrary_event.data.source).toBe('overlay');
    });
  });

  describe('Word Overlay Events', () => {
    it('should track academia button view', async () => {
      const projectId = 555;
      const fileId = 666;

      analytics.trackAcademiaButtonView(projectId, fileId);

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('academia_button');
      expect(call[1].data.arbitrary_event.data.action).toBe('view');
      expect(call[1].data.arbitrary_event.data.source).toBe('overlay');
    });

    it('should track new review click with all metadata', async () => {
      const projectId = 555;
      const fileId = 666;
      const conversationId = 777;
      const agentName = 'science_agent';

      analytics.trackAcademiaButtonNewReviewClick(
        projectId,
        fileId,
        conversationId,
        agentName
      );

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'academia_button_new_review',
              action: 'click',
              source: 'overlay',
              metadata: {
                file_id: fileId,
                conversation_id: conversationId,
                agent_name: agentName,
              },
              project_id: projectId,
            },
          },
        },
      });
    });
  });

  describe('Error Handling', () => {
    it('should not throw when API call fails', async () => {
      mockInvoke.mockRejectedValue(new Error('API Error'));

      // Should not throw
      expect(() => {
        analytics.trackProjectClick(123);
      }).not.toThrow();

      await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('should continue execution after failed analytics call', async () => {
      mockInvoke.mockRejectedValue(new Error('Network error'));

      analytics.trackProjectsView();
      analytics.trackProjectClick(123);

      await new Promise(resolve => setTimeout(resolve, 0));

      // Both calls should have been attempted
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('Event Structure Validation', () => {
    it('should always use DesktopAppEvent as event_type', async () => {
      const trackingFunctions = [
        () => analytics.trackProjectsView(),
        () => analytics.trackProjectClick(1),
        () => analytics.trackNewProjectClick(),
        () => analytics.trackConversationView(1, 2, 'agent'),
        () => analytics.trackNotificationView(1, 2, 'agent'),
      ];

      for (const fn of trackingFunctions) {
        fn();
      }

      await new Promise(resolve => setTimeout(resolve, 0));

      mockInvoke.mock.calls.forEach(call => {
        expect(call[1].data.arbitrary_event.event_type).toBe('DesktopAppEvent');
      });
    });

    it('should always include metadata object even if empty', async () => {
      analytics.trackProjectsView();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.metadata).toEqual({});
      expect(call[1].data.arbitrary_event.data.metadata).not.toBeNull();
      expect(call[1].data.arbitrary_event.data.metadata).not.toBeUndefined();
    });

    it('should use correct endpoint', async () => {
      analytics.trackProjectClick(123);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(
        IPC_CHANNELS.API_CALL,
        expect.objectContaining({
          endpoint: 'v0/arbitrary_event',
        })
      );
    });

    it('should use POST method', async () => {
      analytics.trackProjectClick(123);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(
        IPC_CHANNELS.API_CALL,
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('Getting Started Events', () => {
    it('should track getting started view with full structure', async () => {
      analytics.trackGettingStartedView();

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'getting_started_view',
              action: 'view',
              source: 'desktop',
              metadata: {},
            },
          },
        },
      });
    });

    it('should track getting started view with no project_id', async () => {
      analytics.trackGettingStartedView();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.project_id).toBeUndefined();
    });

    it('should track getting started login click', async () => {
      analytics.trackGettingStartedLoginClick();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('getting_started_login_click');
      expect(call[1].data.arbitrary_event.data.action).toBe('click');
    });

    it('should track getting started permission granted', async () => {
      analytics.trackGettingStartedPermissionGranted();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('getting_started_permission_granted');
      expect(call[1].data.arbitrary_event.data.action).toBe('granted');
    });

    it('should track getting started zotero synced', async () => {
      analytics.trackGettingStartedZoteroSynced();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('getting_started_zotero_synced');
      expect(call[1].data.arbitrary_event.data.action).toBe('completed');
    });

    it('should track getting started zotero skipped', async () => {
      analytics.trackGettingStartedZoteroSkipped();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('getting_started_zotero_skipped');
      expect(call[1].data.arbitrary_event.data.action).toBe('skipped');
    });

    it('should track getting started file picker open', async () => {
      analytics.trackGettingStartedFilePickerOpen();

      await new Promise(resolve => setTimeout(resolve, 0));

      const call = mockInvoke.mock.calls[0];
      expect(call[1].data.arbitrary_event.data.event_name).toBe('getting_started_file_picker_open');
      expect(call[1].data.arbitrary_event.data.action).toBe('open');
    });

    it('should track getting started project created with full structure', async () => {
      const projectId = 999;
      analytics.trackGettingStartedProjectCreated(projectId);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.API_CALL, {
        method: 'POST',
        endpoint: 'v0/arbitrary_event',
        data: {
          arbitrary_event: {
            event_type: 'DesktopAppEvent',
            data: {
              event_name: 'getting_started_project_created',
              action: 'created',
              source: 'desktop',
              metadata: {},
              project_id: projectId,
            },
          },
        },
      });
    });
  });
});
