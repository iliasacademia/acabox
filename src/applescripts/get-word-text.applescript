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

		-- Check if Word is frontmost
		tell application "System Events"
			set frontmostApp to name of first application process whose frontmost is true
		end tell

		set isFrontmost to (frontmostApp is "Microsoft Word")

		-- Get all documents
		set docList to {}
		set docCount to count of documents
		repeat with i from 1 to docCount
			set doc to document i
			set docName to name of doc
			set docContent to content of text object of doc
			set end of docList to "==DOC_START==" & return & docName & return & "==CONTENT==" & return & docContent & return & "==DOC_END=="
		end repeat

		-- Join all documents with newlines
		set allDocs to ""
		repeat with docInfo in docList
			set allDocs to allDocs & docInfo & return
		end repeat

		if isFrontmost then
			-- Return format: status,isFrontmost,documents
			return "success,true," & allDocs
		else
			return "success,false," & allDocs
		end if
	on error errMsg
		return "error,false,Error: " & errMsg
	end try
end tell
