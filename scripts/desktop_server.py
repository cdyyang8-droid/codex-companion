"""Entry point used by the bundled desktop backend."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from monitor import main

if __name__ == '__main__':
    main()
