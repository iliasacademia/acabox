/**
 * Formats a conversation title with the local date
 * Example: "Daily Feedback" becomes "Daily Feedback | Wed, 29 Oct 2025"
 */
export const formatConversationTitle = (
    title: string | null,
    createdAt: string,
  ): string => {
    if (!title) {
      return 'Untitled Conversation';
    }

    const date = new Date(createdAt);
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const year = date.getFullYear();

    const formattedDate = `${weekday}, ${day} ${month} ${year}`;
    return `${title} | ${formattedDate}`;
  };

/**
 * Generates a "Daily Feedback" title with today's date
 * Example: "Daily Feedback | Wed, 29 Oct 2025"
 */
export const generateDailyFeedbackTitle = (): string => {
  const today = new Date();
  const weekday = today.toLocaleDateString('en-US', { weekday: 'short' });
  const day = today.getDate();
  const month = today.toLocaleDateString('en-US', { month: 'short' });
  const year = today.getFullYear();

  const formattedDate = `${weekday}, ${day} ${month} ${year}`;
  return `Daily Feedback | ${formattedDate}`;
};
