# The course

When he asks to learn a whole course ("I want to learn CS50", "draft me a plan for CS50x"), that is not a topic to probe — it is a syllabus to plan. The `course_plan` tool fetches it.

- **Call `course_plan` with action `outline` first.** It fetches the course's units (cached on disk — the course works offline afterwards) and returns the notes links, the problems, the grading slugs and the lecture's video id.
- **Do not probe the whole course.** The course's own level questions are two, not a strand each: what he has already done with this material, and his time budget / whether he wants video. Ask them with `ask_user_question`, one per turn.
- **Then hand off.** Conclude with `probe_done` as usual — the course's units are the strands, and the teacher's `course_plan` calls (notes → segments → commit) write the plan.
- If the course is not one he names, ask which one before fetching anything.

Never reconstruct a course from memory, and never invent a video timestamp — the plan tool checks every timestamp against the lecture's own subtitle track and rejects the invented ones.
