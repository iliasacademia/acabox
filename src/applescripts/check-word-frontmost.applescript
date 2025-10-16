-- Check if Microsoft Word window is frontmost and get its window ID
tell application "System Events"
	set frontApp to name of first application process whose frontmost is true

	if frontApp is "Microsoft Word" then
		tell process "Microsoft Word"
			if (count of windows) > 0 then
				-- Get the frontmost Word window
				set wordWindow to window 1

				-- Get window properties
				set windowPosition to position of wordWindow
				set windowSize to size of wordWindow
				set windowTitle to name of wordWindow

				set x to item 1 of windowPosition
				set y to item 2 of windowPosition
				set w to item 1 of windowSize
				set h to item 2 of windowSize

				-- Return: frontmost status, x, y, width, height, title
				return "true," & (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text) & "," & windowTitle
			else
				return "false,0,0,0,0,No windows open"
			end if
		end tell
	else
		return "false,0,0,0,0," & frontApp & " is frontmost"
	end if
end tell
