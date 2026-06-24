---
trigger: always_on
---

Workspace Protocol: Reverse Engineering & Research (RER-01)

1. Mandatory Consultation Rule

Consultation Requirement: No independent reverse-engineering (RE) or deep-search initiatives are to be executed autonomously. Before any technical deconstruction or exploratory search begins, you must present a Research Brief to the Lead (Me). Execution may only proceed once the step-by-step methodology has been reviewed and approved.

2. Reverse Engineering: The Standard Process
   Reverse engineering is the systematic deconstruction of a target to understand its internal logic. Follow these steps when preparing your brief:

Step 1: Environmental Isolation (Sandboxing)
Install the target in a Virtual Machine (VM) or container. Ensure the network is "Host-only" or disabled to prevent data leakage or "phone home" signals.

Step 2: Static Analysis (Code Review)
Examine the file without executing it. Use a Disassembler to turn machine code into assembly, or a Decompiler to attempt a reconstruction of high-level code.

Tools: Ghidra, IDA Pro, ILSpy.

Step 3: Dynamic Analysis (Execution Monitoring)
Run the program through a Debugger. Set "Breakpoints" at suspicious points to freeze the program and inspect the CPU registers and memory.

Tools: x64dbg, GDB, OllyDbg.

Step 4: Behavioral Tracking
Monitor system-level changes. What registry keys are modified? What temporary files are created?

Tools: Process Monitor (ProcMon), Wireshark (for network traffic).

3. Research & Search: The Methodology
   When searching for technical solutions, move from Identifiers to Context:

Phase A: Extract Signatures
Never search for generic problems. Search for:

Magic Numbers: (e.g., 0x504B0304 for ZIP files).

Error Offsets: Specific memory addresses (e.g., Exception at 0x00401234).

Unique Strings: Hardcoded messages or unique function names found during static analysis.

Phase B: Advanced Query Logic
Refine searches to eliminate noise:

"exact phrase": Forces the search engine to find that specific string.

filetype:pdf: To find whitepapers or technical manuals.

site:github.com: To find source code implementations of similar logic.

after:2024: To ensure the documentation isn't obsolete.

Phase C: Verification
Cross-reference findings across niche communities (Stack Exchange, specialized RE forums, or official API documentation).

4. Execution Workflow
   Identify the target.

Extract preliminary strings/headers.

Propose the specific tools and search queries to the Lead.

Execute only upon confirmation.
