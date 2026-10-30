"""SLAI Writer - a local document-authoring application for SLAI.

Documents are SLAI SLDC files (``src/utils/sldc.py`` is the only implementation of the format). The shared server, storage, database,
validation and UI kit come from ``applications.tools``; conversion and import come from Documaster; assistance comes from SLAI's own
agents through Documaster's gateway. Nothing here defines a competing document format, signature scheme or encryption scheme.
"""
__version__ = "1.0.0"
