tell application "System Events"
	tell process "Microsoft Word"
		set wordWindow to window 1
		set output to ""

		-- Try to get text areas
		try
			set textAreas to every text area of wordWindow
			set textAreaCount to count of textAreas
			set output to output & "Text area count: " & textAreaCount & "\n"

			if textAreaCount > 0 then
				set firstTextArea to item 1 of textAreas

				-- Try to get value (content)
				try
					set contentValue to value of firstTextArea
					set output to output & "Content value available: YES\n"
					set contentLen to length of contentValue
					set output to output & "Content length: " & contentLen & "\n"
					set output to output & "Content preview:\n" & contentValue & "\n"
				on error errMsg
					set output to output & "Content value error: " & errMsg & "\n"
				end try

				-- Try to get position
				try
					set areaPosition to position of firstTextArea
					set posX to item 1 of areaPosition
					set posY to item 2 of areaPosition
					set output to output & "Position: " & posX & ", " & posY & "\n"
				on error errMsg
					set output to output & "Position error: " & errMsg & "\n"
				end try

				-- Try to get size
				try
					set areaSize to size of firstTextArea
					set sizeW to item 1 of areaSize
					set sizeH to item 2 of areaSize
					set output to output & "Size: " & sizeW & " x " & sizeH & "\n"
				on error errMsg
					set output to output & "Size error: " & errMsg & "\n"
				end try
			end if
		on error errMsg
			set output to output & "Text area access error: " & errMsg & "\n"
		end try

		-- Try to get UI elements
		try
			set allUIElements to every UI element of wordWindow
			set elementCount to count of allUIElements
			set output to output & "UI element count: " & elementCount & "\n\n"

			-- Inspect each UI element
			repeat with i from 1 to elementCount
				set currentElement to item i of allUIElements
				set output to output & "Element " & i & ":\n"

				try
					set elementRole to role of currentElement
					set output to output & "  Role: " & elementRole & "\n"
				on error
					set output to output & "  Role: unknown\n"
				end try

				try
					set elementDesc to description of currentElement
					set output to output & "  Description: " & elementDesc & "\n"
				on error
					set output to output & "  Description: none\n"
				end try

				try
					set elementTitle to title of currentElement
					set output to output & "  Title: " & elementTitle & "\n"
				on error
					set output to output & "  Title: none\n"
				end try

				try
					set elementValue to value of currentElement
					if elementValue is not missing value then
						set output to output & "  Value available: YES\n"
					else
						set output to output & "  Value: none\n"
					end if
				on error
					set output to output & "  Value: error\n"
				end try

				try
					set elementPos to position of currentElement
					set output to output & "  Position: " & (item 1 of elementPos) & ", " & (item 2 of elementPos) & "\n"
				on error
					set output to output & "  Position: error\n"
				end try

				try
					set elementSz to size of currentElement
					set output to output & "  Size: " & (item 1 of elementSz) & " x " & (item 2 of elementSz) & "\n"
				on error
					set output to output & "  Size: error\n"
				end try

				try
					set elementAttrs to attributes of currentElement
					set attrCount to count of elementAttrs
					set output to output & "  Attributes count: " & attrCount & "\n"
				on error
					set output to output & "  Attributes: error\n"
				end try

				try
					set subElements to every UI element of currentElement
					set subCount to count of subElements
					set output to output & "  Sub-elements count: " & subCount & "\n"

					-- If this is Element 1 (split group), explore its sub-elements
					if i is equal to 1 and subCount > 0 then
						set output to output & "\n  Exploring sub-elements of Element 1:\n"
						repeat with j from 1 to subCount
							set subElement to item j of subElements
							set output to output & "  Sub-element " & j & ":\n"

							try
								set subRole to role of subElement
								set output to output & "    Role: " & subRole & "\n"
							on error
								set output to output & "    Role: error\n"
							end try

							try
								set subDesc to description of subElement
								set output to output & "    Description: " & subDesc & "\n"
							on error
								set output to output & "    Description: error\n"
							end try

							try
								set subVal to value of subElement
								if subVal is not missing value then
									set output to output & "    Value available: YES\n"
									set valLen to length of (subVal as string)
									set output to output & "    Value length: " & valLen & "\n"
								else
									set output to output & "    Value: none\n"
								end if
							on error
								set output to output & "    Value: error\n"
							end try

							try
								set subPos to position of subElement
								set output to output & "    Position: " & (item 1 of subPos) & ", " & (item 2 of subPos) & "\n"
							on error
								set output to output & "    Position: error\n"
							end try

							try
								set subSz to size of subElement
								set output to output & "    Size: " & (item 1 of subSz) & " x " & (item 2 of subSz) & "\n"
							on error
								set output to output & "    Size: error\n"
							end try

							try
								set subSubElements to every UI element of subElement
								set subSubCount to count of subSubElements
								set output to output & "    Sub-sub-elements count: " & subSubCount & "\n"

								-- If this is sub-element 1 with children, explore deeper
								if j is equal to 1 and subSubCount > 0 then
									set output to output & "\n    Exploring sub-sub-elements:\n"
									repeat with k from 1 to subSubCount
										set subSubElement to item k of subSubElements
										set output to output & "    Sub-sub-element " & k & ":\n"

										try
											set subSubRole to role of subSubElement
											set output to output & "      Role: " & subSubRole & "\n"
										on error
											set output to output & "      Role: error\n"
										end try

										try
											set subSubDesc to description of subSubElement
											set output to output & "      Description: " & subSubDesc & "\n"
										on error
											set output to output & "      Description: error\n"
										end try

										try
											set subSubVal to value of subSubElement
											if subSubVal is not missing value then
												set output to output & "      Value available: YES\n"
												set valLength to length of (subSubVal as string)
												set output to output & "      Value length: " & valLength & "\n"
											else
												set output to output & "      Value: none\n"
											end if
										on error
											set output to output & "      Value: error\n"
										end try

										try
											set subSubPos to position of subSubElement
											set output to output & "      Position: " & (item 1 of subSubPos) & ", " & (item 2 of subSubPos) & "\n"
										on error
											set output to output & "      Position: error\n"
										end try

										try
											set subSubSz to size of subSubElement
											set output to output & "      Size: " & (item 1 of subSubSz) & " x " & (item 2 of subSubSz) & "\n"
										on error
											set output to output & "      Size: error\n"
										end try

										-- Level 4: Go deeper
										try
											set level4Elements to every UI element of subSubElement
											set level4Count to count of level4Elements
											set output to output & "      Level 4 elements count: " & level4Count & "\n"

											if level4Count > 0 then
												set output to output & "\n      Exploring Level 4:\n"
												repeat with m from 1 to level4Count
													set level4Element to item m of level4Elements
													set output to output & "      Level 4 Element " & m & ":\n"

													try
														set l4Role to role of level4Element
														set output to output & "        Role: " & l4Role & "\n"
													on error
														set output to output & "        Role: error\n"
													end try

													try
														set l4Desc to description of level4Element
														set output to output & "        Description: " & l4Desc & "\n"
													on error
														set output to output & "        Description: error\n"
													end try

													try
														set l4Val to value of level4Element
														if l4Val is not missing value then
															set output to output & "        Value available: YES\n"
															set l4ValLen to length of (l4Val as string)
															set output to output & "        Value length: " & l4ValLen & "\n"
														else
															set output to output & "        Value: none\n"
														end if
													on error
														set output to output & "        Value: error\n"
													end try

													try
														set l4Pos to position of level4Element
														set output to output & "        Position: " & (item 1 of l4Pos) & ", " & (item 2 of l4Pos) & "\n"
													on error
														set output to output & "        Position: error\n"
													end try

													try
														set l4Size to size of level4Element
														set output to output & "        Size: " & (item 1 of l4Size) & " x " & (item 2 of l4Size) & "\n"
													on error
														set output to output & "        Size: error\n"
													end try

													-- Level 5: Go even deeper
													try
														set level5Elements to every UI element of level4Element
														set level5Count to count of level5Elements
														set output to output & "        Level 5 elements count: " & level5Count & "\n"

														if level5Count > 0 then
															set output to output & "\n        Exploring Level 5:\n"
															repeat with n from 1 to level5Count
																set level5Element to item n of level5Elements
																set output to output & "        Level 5 Element " & n & ":\n"

																try
																	set l5Role to role of level5Element
																	set output to output & "          Role: " & l5Role & "\n"
																on error
																	set output to output & "          Role: error\n"
																end try

																try
																	set l5Desc to description of level5Element
																	set output to output & "          Description: " & l5Desc & "\n"
																on error
																	set output to output & "          Description: error\n"
																end try

																try
																	set l5Val to value of level5Element
																	if l5Val is not missing value then
																		set output to output & "          Value available: YES\n"
																		set l5ValLen to length of (l5Val as string)
																		set output to output & "          Value length: " & l5ValLen & "\n"
																	else
																		set output to output & "          Value: none\n"
																	end if
																on error
																	set output to output & "          Value: error\n"
																end try

																try
																	set l5Pos to position of level5Element
																	set output to output & "          Position: " & (item 1 of l5Pos) & ", " & (item 2 of l5Pos) & "\n"
																on error
																	set output to output & "          Position: error\n"
																end try

																try
																	set l5Size to size of level5Element
																	set output to output & "          Size: " & (item 1 of l5Size) & " x " & (item 2 of l5Size) & "\n"
																on error
																	set output to output & "          Size: error\n"
																end try

																-- Level 6: One more level
																try
																	set level6Elements to every UI element of level5Element
																	set level6Count to count of level6Elements
																	set output to output & "          Level 6 elements count: " & level6Count & "\n"

																	if level6Count > 0 then
																		set output to output & "\n          Exploring Level 6:\n"
																		repeat with p from 1 to level6Count
																			set level6Element to item p of level6Elements
																			set output to output & "          Level 6 Element " & p & ":\n"

																			try
																				set l6Role to role of level6Element
																				set output to output & "            Role: " & l6Role & "\n"
																			on error
																				set output to output & "            Role: error\n"
																			end try

																			try
																				set l6Desc to description of level6Element
																				set output to output & "            Description: " & l6Desc & "\n"
																			on error
																				set output to output & "            Description: error\n"
																			end try

																			try
																				set l6Val to value of level6Element
																				if l6Val is not missing value then
																					set output to output & "            Value available: YES\n"
																					set l6ValLen to length of (l6Val as string)
																					set output to output & "            Value length: " & l6ValLen & "\n"
																					if l6ValLen > 0 and l6ValLen < 500 then
																						set output to output & "            Value content: " & l6Val & "\n"
																					end if
																				else
																					set output to output & "            Value: none\n"
																				end if
																			on error
																				set output to output & "            Value: error\n"
																			end try

																			try
																				set l6Pos to position of level6Element
																				set output to output & "            Position: " & (item 1 of l6Pos) & ", " & (item 2 of l6Pos) & "\n"
																			on error
																				set output to output & "            Position: error\n"
																			end try

																			try
																				set l6Size to size of level6Element
																				set output to output & "            Size: " & (item 1 of l6Size) & " x " & (item 2 of l6Size) & "\n"
																			on error
																				set output to output & "            Size: error\n"
																			end try

																			try
																				set level7Elements to every UI element of level6Element
																				set level7Count to count of level7Elements
																				set output to output & "            Level 7 elements count: " & level7Count & "\n"
																			on error
																				set output to output & "            Level 7 elements: error\n"
																			end try

																			-- If this is the AXLayoutArea (likely element 1), try more attributes
																			if p is equal to 1 and l6Role is equal to "AXLayoutArea" then
																				set output to output & "\n            ** Detailed inspection of AXLayoutArea **\n"

																				try
																					set l6Title to title of level6Element
																					set output to output & "            Title: " & l6Title & "\n"
																				on error
																					set output to output & "            Title: none\n"
																				end try

																				try
																					set l6Help to help of level6Element
																					set output to output & "            Help: " & l6Help & "\n"
																				on error
																					set output to output & "            Help: none\n"
																				end try

																				try
																					set l6Subrole to subrole of level6Element
																					set output to output & "            Subrole: " & l6Subrole & "\n"
																				on error
																					set output to output & "            Subrole: none\n"
																				end try

																				try
																					set l6RoleDesc to role description of level6Element
																					set output to output & "            Role description: " & l6RoleDesc & "\n"
																				on error
																					set output to output & "            Role description: none\n"
																				end try

																				try
																					set l6AllAttrs to attributes of level6Element
																					set l6AttrCount to count of l6AllAttrs
																					set output to output & "            Total attributes: " & l6AttrCount & "\n"

																					-- List all attribute names and values
																					set output to output & "            Attribute names and values:\n"
																					repeat with attrIndex from 1 to l6AttrCount
																						try
																							set currentAttr to item attrIndex of l6AllAttrs
																							set attrName to name of currentAttr
																							set output to output & "              " & attrIndex & ". " & attrName & ": "

																							try
																								tell level6Element
																									set attrVal to value of attribute attrName
																								end tell
																								if attrVal is missing value then
																									set output to output & "missing value\n"
																								else
																									set valType to class of attrVal
																									if valType is list then
																										set valCount to count of attrVal
																										set output to output & "list with " & valCount & " items: "
																										-- Print list items for geometric attributes
																										if attrName is in {"AXFrame", "AXRectInParentSpace", "AXSize", "AXPosition"} then
																											set listStr to "["
																											repeat with listIdx from 1 to valCount
																												set listItem to item listIdx of attrVal
																												if listIdx > 1 then
																													set listStr to listStr & ", "
																												end if
																												set listStr to listStr & (listItem as string)
																											end repeat
																											set listStr to listStr & "]"
																											set output to output & listStr & "\n"
																										else
																											set output to output & "\n"
																										end if
																									else if valType is string or valType is integer or valType is real or valType is boolean then
																										set output to output & (attrVal as string) & "\n"
																									else
																										set output to output & "type: " & valType & "\n"
																									end if
																								end if
																							on error errMsg
																								set output to output & "error: " & errMsg & "\n"
																							end try
																						on error
																							set output to output & "              " & attrIndex & ". error getting name\n"
																						end try
																					end repeat
																				on error
																					set output to output & "            Total attributes: error\n"
																				end try

																				-- Try to access AXSelectedText (using attribute instead)
																				try
																					tell level6Element
																						set l6SelectedText to value of attribute "AXSelectedText"
																					end tell
																					set output to output & "            Selected text: " & l6SelectedText & "\n"
																				on error errMsg
																					set output to output & "            Selected text error: " & errMsg & "\n"
																				end try

																				-- Try to access AXVisibleCharacterRange (using attribute)
																				try
																					tell level6Element
																						set l6VisibleRange to value of attribute "AXVisibleCharacterRange"
																					end tell
																					set output to output & "            Visible char range: " & (l6VisibleRange as string) & "\n"
																				on error errMsg
																					set output to output & "            Visible char range error: " & errMsg & "\n"
																				end try

																				-- Try to get contents
																				try
																					set l6Contents to contents of level6Element
																					set output to output & "            Contents: " & (l6Contents as string) & "\n"
																				on error errMsg
																					set output to output & "            Contents error: " & errMsg & "\n"
																				end try

																				-- Try entire contents
																				try
																					set l6EntireContents to entire contents of level6Element
																					set contentsCount to count of l6EntireContents
																					set output to output & "            Entire contents count: " & contentsCount & "\n"
																					if contentsCount > 0 then
																						repeat with ec from 1 to (minimum of {5, contentsCount})
																							set ecItem to item ec of l6EntireContents
																							try
																								set ecRole to role of ecItem
																								set output to output & "              Item " & ec & " role: " & ecRole & "\n"
																							on error
																								set output to output & "              Item " & ec & ": " & (ecItem as string) & "\n"
																							end try
																						end repeat
																					end if
																				on error errMsg
																					set output to output & "            Entire contents error: " & errMsg & "\n"
																				end try

																				-- Try to get text areas within this element differently
																				try
																					tell level6Element
																						set nestedTextAreas to (every UI element whose role is "AXTextArea")
																					end tell
																					set nestedTACount to count of nestedTextAreas
																					set output to output & "            Nested text areas: " & nestedTACount & "\n"
																				on error errMsg
																					set output to output & "            Nested text areas error: " & errMsg & "\n"
																				end try

																				-- Try UI element with different filters (avoid "static text" keyword conflict)
																				try
																					tell level6Element
																						set staticTextElements to (every UI element whose role is "AXStaticText")
																					end tell
																					set stCount to count of staticTextElements
																					set output to output & "            Static texts: " & stCount & "\n"
																				on error errMsg
																					set output to output & "            Static texts error: " & errMsg & "\n"
																				end try

																				-- Try groups
																				try
																					set groups to every group of level6Element
																					set groupCount to count of groups
																					set output to output & "            Groups: " & groupCount & "\n"
																				on error errMsg
																					set output to output & "            Groups error: " & errMsg & "\n"
																				end try

																				-- Try rows (like table rows)
																				try
																					set rows to every row of level6Element
																					set rowCount to count of rows
																					set output to output & "            Rows: " & rowCount & "\n"
																				on error errMsg
																					set output to output & "            Rows error: " & errMsg & "\n"
																				end try

																				-- Try AXCustomContent attribute
																				try
																					tell level6Element
																						set customContent to value of attribute "AXCustomContent"
																					end tell
																					if customContent is not missing value then
																						set output to output & "            AXCustomContent available: YES\n"
																						set ccCount to count of customContent
																						set output to output & "            AXCustomContent count: " & ccCount & "\n"
																					else
																						set output to output & "            AXCustomContent: none\n"
																					end if
																				on error errMsg
																					set output to output & "            AXCustomContent error: " & errMsg & "\n"
																				end try

																				-- Try AXHandles attribute
																				try
																					tell level6Element
																						set handles to value of attribute "AXHandles"
																					end tell
																					if handles is not missing value then
																						set output to output & "            AXHandles available: YES\n"
																						set handlesCount to count of handles
																						set output to output & "            AXHandles count: " & handlesCount & "\n"
																					else
																						set output to output & "            AXHandles: none\n"
																					end if
																				on error errMsg
																					set output to output & "            AXHandles error: " & errMsg & "\n"
																				end try

																				-- Try AXVisibleChildren attribute (different from every UI element)
																				try
																					tell level6Element
																						set visibleChildren to value of attribute "AXVisibleChildren"
																					end tell
																					if visibleChildren is not missing value then
																						set output to output & "            AXVisibleChildren available: YES\n"
																						set vcCount to count of visibleChildren
																						set output to output & "            AXVisibleChildren count: " & vcCount & "\n"
																					else
																						set output to output & "            AXVisibleChildren: none\n"
																					end if
																				on error errMsg
																					set output to output & "            AXVisibleChildren error: " & errMsg & "\n"
																				end try
																			end if

																			set output to output & "\n"
																		end repeat
																	end if
																on error
																	set output to output & "          Level 6 elements: error\n"
																end try

																set output to output & "\n"
															end repeat
														end if
													on error
														set output to output & "        Level 5 elements: error\n"
													end try

													set output to output & "\n"
												end repeat
											end if
										on error
											set output to output & "      Level 4 elements: error\n"
										end try

										set output to output & "\n"
									end repeat
								end if
							on error
								set output to output & "    Sub-sub-elements: error\n"
							end try

							set output to output & "\n"
						end repeat
					end if
				on error
					set output to output & "  Sub-elements: error\n"
				end try

				set output to output & "\n"
			end repeat
		on error errMsg
			set output to output & "UI element error: " & errMsg & "\n"
		end try

		return output
	end tell
end tell
