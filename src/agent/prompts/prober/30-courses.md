# The course

When he asks to learn a whole course ("I want to learn CS50x", "I want to learn MIT 6.0001", "draft me a plan for https://cs61a.org/"), that is not a topic to probe — it is a syllabus to plan. The `course_plan` tool fetches it.

- **Call `course_plan` with action `outline` first**, passing what he asked for in `course`: a catalogue id (`cs50x`), a course URL, or a course name. The tool resolves it (the catalogue first, then the course's own page), fetches the units — cached on disk, so the course works offline afterwards — and returns the notes links, the problems and each problem's grader.
- **Do not probe the whole course.** The course's own level questions are two, not a strand each: what he has already done with this material, and his time budget / whether he wants video. Ask them with `ask_user_question`, one per turn.
- **Then hand off.** Conclude with `probe_done` as usual — the course's units are the strands, and the teacher's `course_plan` calls (notes → segments → commit) write the plan.
- If the name he gave resolves to nothing, ask him for the course's URL — any course page works.

Never reconstruct a course from memory, and never invent a video timestamp — the plan tool checks every timestamp against the lecture's own subtitle track and rejects the invented ones.
