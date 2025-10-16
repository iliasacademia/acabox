tell application "Microsoft Word"
	if it is running then
		if (count of documents) > 0 then
			set output to ""
			set activeDoc to active document

			-- Document properties
			try
				set docName to name of activeDoc
				set output to output & "Document name: " & docName & "\n\n"
			on error errMsg
				set output to output & "Document name error: " & errMsg & "\n\n"
			end try

			-- Get text object and inspect all its properties
			try
				set docTextObj to text object of activeDoc
				set output to output & "=== TEXT OBJECT INSPECTION ===\n"
				set output to output & "Text object available: YES\n\n"

				-- Get all properties of the main text object
				try
					set textObjProps to properties of docTextObj
					set output to output & "Text Object Properties:\n"
					repeat with propKey in textObjProps
						try
							set propName to propKey as string
							set propValue to item propKey of textObjProps
							-- Try to convert to string, skip if not convertible
							try
								set propValueStr to propValue as string
								if length of propValueStr < 200 then
									set output to output & "  " & propName & ": " & propValueStr & "\n"
								else
									set output to output & "  " & propName & ": [value too long]\n"
								end if
							on error
								set output to output & "  " & propName & ": [not convertible to string]\n"
							end try
						on error
							-- Skip properties that can't be accessed
						end try
					end repeat
					set output to output & "\n"
				on error errMsg
					set output to output & "Text object properties error: " & errMsg & "\n\n"
				end try

				-- Try to get content from main text object
				try
					set textContent to content of docTextObj
					if textContent is not missing value then
						set contentLen to length of textContent
						if contentLen > 0 then
							-- Replace newlines with visible \n for debugging
							set AppleScript's text item delimiters to return
							set contentParts to text items of textContent
							set AppleScript's text item delimiters to "\\n"
							set visibleContent to contentParts as string
							set AppleScript's text item delimiters to ""

							if contentLen > 1000 then
								set output to output & "Text Object Content (first 1000 chars, newlines shown as \\n):\n" & (characters 1 thru 1000 of visibleContent as string) & "...\n"
							else
								set output to output & "Text Object Content (newlines shown as \\n):\n" & visibleContent & "\n"
							end if
						else
							set output to output & "Text Object Content: [empty]\n"
						end if
					else
						set output to output & "Text Object Content: missing value\n"
					end if
					set output to output & "\n"
				on error errMsg
					set output to output & "Text object content error: " & errMsg & "\n\n"
				end try

			on error errMsg
				set output to output & "Text object error: " & errMsg & "\n\n"
			end try

			-- Try to get words collection
			try
				set wordsList to every word of text object of activeDoc
				set wordsCount to count of wordsList
				set output to output & "Total words in document: " & wordsCount & "\n\n"

				-- Inspect first 5 words
				if wordsCount > 0 then
					set output to output & "Inspecting first 5 words:\n\n"
					repeat with i from 1 to (minimum of {5, wordsCount})
						set currentWord to item i of wordsList
						set output to output & "Word " & i & ":\n"

						-- Get word content
						try
							set wordContent to content of currentWord
							set output to output & "  Content: " & wordContent & "\n"
						on error errMsg
							set output to output & "  Content error: " & errMsg & "\n"
						end try

						-- Try to get font
						try
							set wordFont to font object of currentWord
							set output to output & "  Font object available: YES\n"
						on error errMsg
							set output to output & "  Font error: " & errMsg & "\n"
						end try

						-- Try to get start/end of range
						try
							set wordStart to start of range of currentWord
							set wordEnd to end of range of currentWord
							set output to output & "  Range: start=" & wordStart & ", end=" & wordEnd & "\n"
						on error errMsg
							set output to output & "  Range error: " & errMsg & "\n"
						end try

						-- Try to get position/bounds (THIS IS KEY)
						try
							set wordBounds to get bounds of currentWord
							set output to output & "  Bounds: " & (wordBounds as string) & "\n"
						on error errMsg
							set output to output & "  Bounds error: " & errMsg & "\n"
						end try

						-- Try horizontal position
						try
							set wordHPos to horizontal position of currentWord
							set output to output & "  Horizontal position: " & wordHPos & "\n"
						on error errMsg
							set output to output & "  Horizontal position error: " & errMsg & "\n"
						end try

						-- Try vertical position
						try
							set wordVPos to vertical position of currentWord
							set output to output & "  Vertical position: " & wordVPos & "\n"
						on error errMsg
							set output to output & "  Vertical position error: " & errMsg & "\n"
						end try

						-- Try information property
						try
							-- Word has various information types we can query
							-- Note: "as horizontal position in points" is not valid AppleScript syntax
						set wordInfo to get information of currentWord
							set output to output & "  Info: " & (wordInfo as string) & "\n"
						on error errMsg
							set output to output & "  Info error: " & errMsg & "\n"
						end try

						set output to output & "\n"
					end repeat
				end if
			on error errMsg
				set output to output & "Words collection error: " & errMsg & "\n"
			end try

			-- Try paragraphs
			try
				set paragraphsList to every paragraph of text object of activeDoc
				set parasCount to count of paragraphsList
				set output to output & "Total paragraphs: " & parasCount & "\n\n"

				if parasCount > 0 then
					repeat with i from 1 to parasCount
						set currentPara to item i of paragraphsList
						set output to output & "Paragraph " & i & ":\n"

						-- Get all properties of the paragraph
						try
							set paraProps to properties of currentPara
							set output to output & "  Properties:\n"
							repeat with propKey in paraProps
								try
									set propName to propKey as string
									set propValue to item propKey of paraProps
									set output to output & "    " & propName & ": " & (propValue as string) & "\n"
								on error
									-- Skip properties that can't be accessed
								end try
							end repeat
						on error errMsg
							set output to output & "  Properties error: " & errMsg & "\n"
						end try

						-- Get content
						try
							set paraContent to content of currentPara
							if paraContent is not missing value then
								set contentLen to length of paraContent
								if contentLen > 100 then
									set output to output & "  Content (first 100 chars): " & (characters 1 thru 100 of paraContent as string) & "...\n"
								else
									set output to output & "  Content: " & paraContent & "\n"
								end if
							else
								set output to output & "  Content: missing value\n"
							end if
						on error errMsg
							set output to output & "  Content error: " & errMsg & "\n"
						end try

						-- Try to get bounds
						try
							set paraBounds to get bounds of currentPara
							set output to output & "  Bounds: " & (paraBounds as string) & "\n"
						on error errMsg
							set output to output & "  Bounds error: " & errMsg & "\n"
						end try

						set output to output & "\n"
					end repeat
				end if
			on error errMsg
				set output to output & "Paragraphs error: " & errMsg & "\n\n"
			end try

			-- Try characters
			try
				set charsList to every character of text object of activeDoc
				set charsCount to count of charsList
				set output to output & "Total characters: " & charsCount & "\n"

				if charsCount > 0 then
					set firstChar to item 1 of charsList

					-- Get content
					try
						set charContent to content of firstChar
						set output to output & "First character content: " & charContent & "\n"
					on error errMsg
						set output to output & "First character content error: " & errMsg & "\n"
					end try

					-- Try to get position
					try
						set charPos to get bounds of firstChar
						set output to output & "First character bounds: " & (charPos as string) & "\n"
					on error errMsg
						set output to output & "First character bounds error: " & errMsg & "\n"
					end try
				end if
				set output to output & "\n"
			on error errMsg
				set output to output & "Characters error: " & errMsg & "\n\n"
			end try

			-- Try selection
			try
				set currentSelection to selection
				set output to output & "Selection available: YES\n"

				-- Get selection content
				try
					set selContent to content of text object of currentSelection
					set selLen to length of selContent
					if selLen > 100 then
						set output to output & "Selection content (first 100 chars): " & (characters 1 thru 100 of selContent as string) & "...\n"
					else if selLen > 0 then
						set output to output & "Selection content: " & selContent & "\n"
					else
						set output to output & "Selection: empty (cursor position)\n"
					end if
				on error errMsg
					set output to output & "Selection content error: " & errMsg & "\n"
				end try

				-- Try to get selection bounds
				try
					set selBounds to get bounds of currentSelection
					set output to output & "Selection bounds: " & (selBounds as string) & "\n"
				on error errMsg
					set output to output & "Selection bounds error: " & errMsg & "\n"
				end try

				-- Try information about selection
				try
					set selInfo to get information of currentSelection
					set output to output & "Selection info: " & (selInfo as string) & "\n"
				on error errMsg
					set output to output & "Selection info error: " & errMsg & "\n"
				end try
			on error errMsg
				set output to output & "Selection error: " & errMsg & "\n"
			end try

			return output
		else
			error "No documents are open"
		end if
	else
		error "Microsoft Word is not running"
	end if
end tell
