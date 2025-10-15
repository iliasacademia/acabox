tell application "Microsoft Word"
	if it is running then
		if (count of documents) > 0 then
			try
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
		else
			return "error,false,Error: No documents are open"
		end if
	else
		return "error,false,Error: Microsoft Word is not running"
	end if
end tell
