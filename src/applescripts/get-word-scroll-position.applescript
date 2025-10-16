-- Get the current scroll position of Microsoft Word active document
tell application "Microsoft Word"
	if it is running then
		if (count of documents) > 0 then
			try
				-- Get the vertical scroll position (view's vertical percentage)
				set activeDoc to active document
				set activeView to view of active window

				-- Get the selection start position as a proxy for scroll
				-- This gives us a character position that changes with scrolling
				set selStart to (start of selection) as integer

				return selStart as text
			on error errMsg
				return "0"
			end try
		else
			return "0"
		end if
	else
		return "0"
	end if
end tell
