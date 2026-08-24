"""Lightweight heuristic detectors for hedging language, passive voice, and
incomplete sentences in a transcribed answer. These are regex/word-list
heuristics, not a trained NLP model — good enough to flag patterns worth a
candidate's attention, not a linguistically rigorous parse."""

import re

HEDGING_PHRASES = [
    "i think", "i guess", "i feel like", "i suppose", "i mean",
    "sort of", "kind of", "probably", "possibly", "maybe",
    "i'm not sure", "i am not sure", "not really sure",
]

# aux-verb + (optional filler words) + past participle, e.g. "was completed",
# "were being reviewed by the team"
_PASSIVE_RE = re.compile(
    r'\b(?:am|is|are|was|were|be|been|being)\b\s+(?:\w+\s+){0,2}(?:\w+ed|\w+en)\b',
    re.IGNORECASE
)


def count_hedging(text):
    if not text:
        return 0
    lowered = text.lower()
    return sum(
        len(re.findall(r'\b' + re.escape(phrase) + r'\b', lowered))
        for phrase in HEDGING_PHRASES
    )


def count_passive(text):
    if not text:
        return 0
    return len(_PASSIVE_RE.findall(text))


def count_incomplete_sentences(text):
    """Flags sentence-like chunks that trail off without a terminator, or
    fragments too short (<3 words) to be a complete thought — a rough proxy
    for "lost their train of thought" moments."""
    if not text or not text.strip():
        return 0

    parts = re.split(r'(?<=[.!?])\s+', text.strip())
    incomplete = 0
    for part in parts:
        part = part.strip()
        if not part:
            continue
        words = part.split()
        ends_properly = bool(re.search(r'[.!?]$', part))
        if not ends_properly and len(words) >= 3:
            incomplete += 1
        elif len(words) < 3:
            incomplete += 1
    return incomplete


def analyse(text):
    return {
        'hedging_count':    count_hedging(text),
        'passive_count':    count_passive(text),
        'incomplete_count': count_incomplete_sentences(text),
    }
