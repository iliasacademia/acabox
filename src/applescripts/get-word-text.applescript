-- Check if Microsoft Word is running using System Events
tell application "System Events"
	set wordRunning to (exists process "Microsoft Word")
end tell

if not wordRunning then
	return "error,false,Error: Microsoft Word is not running"
end if

-- Word is running, try to get content
tell application "Microsoft Word"
	try
		if (count of documents) is 0 then
			return "error,false,Error: No documents are open"
		end if

		-- Get the text content from the active document
		set docContent to content of text object of active document

		-- Check if Word is frontmost
		tell application "System Events"
			set frontmostApp to name of first application process whose frontmost is true
		end tell

		set isFrontmost to (frontmostApp is "Microsoft Word")

		if isFrontmost then
			-- Return format: status,isFrontmost,content
			return "success,true," & docContent
		else
			return "success,false," & docContent
		end if
	on error errMsg
		return "error,false,Error: " & errMsg
	end try
end tell
