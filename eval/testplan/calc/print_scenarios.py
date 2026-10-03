#!/usr/bin/env python3
"""Print every scenario and value used by testplan.md.  Usage: python3 print_scenarios.py [NAME ...]"""
import sys
from decimal import Decimal
from scenarios import SCN


def fmt(v):
    return f"{v:.2f}" if isinstance(v, Decimal) and v == v.quantize(Decimal('0.01')) and '.' in str(v) else str(v)


def main(names):
    for name, (desc, vals) in SCN.items():
        if names and name not in names:
            continue
        print(f"== {name}: {desc}")
        for k, v in vals.items():
            print(f"   {k:<22} {fmt(v)}")


if __name__ == "__main__":
    main(set(sys.argv[1:]))
