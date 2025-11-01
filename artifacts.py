#!/usr/bin/env python3
"""
Artifact Manager Bootstrapper

Calls artifacts_core.py with the current repo context.

Usage:
    ./artifacts.py pull
    ./artifacts.py push
    ./artifacts.py status
"""

import os
import sys
import subprocess
from pathlib import Path

def main():
    ARTIFACTS_CORE = Path.home() / "work-artifacts" / "artifacts_core.py"

    if 'ARTIFACTS_CORE' in os.environ:
        ARTIFACTS_CORE = Path(os.environ['ARTIFACTS_CORE']).expanduser()
    
    if not ARTIFACTS_CORE.exists():
        print(f"[ERROR] Artifact core not found: {ARTIFACTS_CORE}")
        sys.exit(1)
    
    result = subprocess.run(
        [sys.executable, str(ARTIFACTS_CORE)] + sys.argv[1:],
        cwd=Path.cwd()
    )
    sys.exit(result.returncode)

if __name__ == '__main__':
    main()