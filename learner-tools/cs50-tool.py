#!/usr/bin/env python3
"""The CS50 grader is now the COURSE grader — this file keeps the old name
working (the app's `cli_cs50` tool, and any script that ran it).

Everything lives in course-tool.py, which grades any course: check50 for the
CS50 family, the course's own autograder or test suite for everything else,
and an honest "no autograder" when the course ships none.
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "course-tool.py")

if not os.path.exists(TARGET):
    sys.exit(f"the course grader is missing: {TARGET}")

runpy.run_path(TARGET, run_name="__main__")
