"""
Pit Wall — car customisation catalogue.

Everything the car can be dressed in lives here so the builder stays geometry
and the game/app can drive appearance from data: liveries, F1 tyre compounds
(with the real sidewall colours), rim finishes and the development spec that
decides which parts physically exist on the car.
"""

# ── Liveries ────────────────────────────────────────────────────────────────
# primary   = main body paint
# secondary = engine cover / sidepod shading, second tone of the livery
# accent    = stripes, endplate lips, nose tip, helmet
# trim      = carbon-fibre parts (wings, floor, suspension)
#
# Ten liveries, chosen to spread around the colour wheel rather than to fill a
# number: a set where three entries are all some kind of blue gives the player
# nothing to choose between on a phone-sized car. Hues run lime · navy · red ·
# white · orange · carbon · turquoise · green · magenta · yellow, and each one
# pairs with an accent from the opposite side of the wheel so the stripes stay
# legible at thumbnail size.

LIVERIES = {
    "pitwall": {
        "label": "Pit Wall (takım)",
        "primary": (0.831, 1.0, 0.239, 1.0),              # acid lime / violet
        "secondary": (0.561, 0.69, 0.149, 1.0),
        "accent": (0.608, 0.361, 1.0, 1.0),
        "trim": (0.18, 0.184, 0.208, 1.0),
        "style": "stripe",
    },
    "midnight": {
        "label": "Midnight",
        "primary": (0.075, 0.145, 0.31, 1.0),             # navy / teal
        "secondary": (0.043, 0.086, 0.196, 1.0),
        "accent": (0.176, 0.831, 0.749, 1.0),
        "trim": (0.161, 0.169, 0.196, 1.0),
        "style": "flash",
    },
    "scarlet": {
        "label": "Scarlet",
        "primary": (0.784, 0.078, 0.106, 1.0),            # red / gold
        "secondary": (0.478, 0.035, 0.055, 1.0),
        "accent": (0.949, 0.792, 0.325, 1.0),
        "trim": (0.184, 0.169, 0.169, 1.0),
        "style": "stripe",
    },
    "monza": {
        "label": "Monza White",
        "primary": (0.902, 0.91, 0.898, 1.0),             # white / red
        "secondary": (0.639, 0.655, 0.667, 1.0),
        "accent": (0.831, 0.114, 0.18, 1.0),
        "trim": (0.188, 0.188, 0.2, 1.0),
        "style": "duotone",
    },
    "sunset": {
        "label": "Sunset",
        "primary": (0.945, 0.427, 0.106, 1.0),            # orange / violet
        "secondary": (0.639, 0.216, 0.043, 1.0),
        "accent": (0.396, 0.196, 0.639, 1.0),
        "trim": (0.188, 0.173, 0.169, 1.0),
        "style": "flash",
    },
    "stealth": {
        "label": "Stealth Carbon",
        "primary": (0.098, 0.102, 0.118, 1.0),            # carbon / lime
        "secondary": (0.055, 0.059, 0.071, 1.0),
        "accent": (0.831, 1.0, 0.239, 1.0),
        "trim": (0.145, 0.157, 0.176, 1.0),
        "style": "flash",
    },
    "aqua": {
        "label": "Aqua",
        "primary": (0.176, 0.78, 0.808, 1.0),             # turquoise / white
        "secondary": (0.086, 0.451, 0.49, 1.0),
        "accent": (0.98, 0.98, 0.98, 1.0),
        "trim": (0.169, 0.18, 0.188, 1.0),
        "style": "duotone",
    },
    "emerald": {
        "label": "Emerald",
        "primary": (0.059, 0.42, 0.267, 1.0),             # racing green / gold
        "secondary": (0.039, 0.122, 0.09, 1.0),
        "accent": (0.91, 0.769, 0.353, 1.0),
        "trim": (0.137, 0.165, 0.149, 1.0),
        "style": "split",
    },
    "fuchsia": {
        "label": "Fuchsia",
        "primary": (0.878, 0.114, 0.518, 1.0),            # magenta / cyan
        "secondary": (0.169, 0.039, 0.118, 1.0),
        "accent": (0.169, 0.89, 0.816, 1.0),
        "trim": (0.18, 0.149, 0.173, 1.0),
        "style": "split",
    },
    "solar": {
        "label": "Solar",
        "primary": (1.0, 0.824, 0.118, 1.0),              # yellow / blue
        "secondary": (0.753, 0.541, 0.0, 1.0),
        "accent": (0.141, 0.337, 0.91, 1.0),
        "trim": (0.165, 0.165, 0.18, 1.0),
        "style": "stripe",
    },
}

# Where the secondary / accent colours land on the bodywork.
LIVERY_STYLES = ("stripe", "flash", "duotone", "split", "bare")


# ── Tyre compounds (real F1 sidewall colours) ───────────────────────────────

COMPOUNDS = {
    "SOFT": {
        "label": "Soft",
        "band": (0.906, 0.125, 0.165, 1.0),      # red
        "grooved": False,
        "width_scale": 1.00,
    },
    "MEDIUM": {
        "label": "Medium",
        "band": (1.000, 0.820, 0.180, 1.0),      # yellow
        "grooved": False,
        "width_scale": 1.00,
    },
    "HARD": {
        "label": "Hard",
        "band": (0.945, 0.949, 0.945, 1.0),      # white
        "grooved": False,
        "width_scale": 1.00,
    },
    "INTERMEDIATE": {
        "label": "Intermediate",
        "band": (0.247, 0.639, 0.290, 1.0),      # green
        "grooved": True,
        "width_scale": 0.97,
    },
    "WET": {
        "label": "Wet",
        "band": (0.118, 0.392, 0.784, 1.0),      # blue
        "grooved": True,
        "width_scale": 1.03,
    },
}


# ── Rim finishes ────────────────────────────────────────────────────────────
# "@accent" / "@primary" resolve against the active livery at build time.

RIMS = {
    "silver": {"label": "Silver", "color": (0.812, 0.827, 0.839, 1.0), "metallic": 0.90, "roughness": 0.22},
    "graphite": {"label": "Graphite", "color": (0.153, 0.161, 0.180, 1.0), "metallic": 0.75, "roughness": 0.34},
    "gold": {"label": "Gold", "color": (0.851, 0.678, 0.259, 1.0), "metallic": 0.95, "roughness": 0.20},
    "bronze": {"label": "Bronze", "color": (0.612, 0.400, 0.212, 1.0), "metallic": 0.92, "roughness": 0.28},
    "accent": {"label": "Takım vurgusu", "color": "@accent", "metallic": 0.70, "roughness": 0.26},
    "primary": {"label": "Takım rengi", "color": "@primary", "metallic": 0.70, "roughness": 0.26},
    "white": {"label": "Beyaz", "color": (0.925, 0.929, 0.925, 1.0), "metallic": 0.35, "roughness": 0.30},
}

# Spoke pattern per rim style — pure cosmetics, but it makes wheels feel chosen.
RIM_SPOKES = {"blade": 5, "multi": 10, "turbine": 14}


# ── Development spec → which parts exist ───────────────────────────────────

def tier_of(value: float) -> int:
    """T1 below 60, T2 60-69, T3 70 and above."""
    return 3 if value >= 70 else 2 if value >= 60 else 1


def spec_letter(average: float) -> str:
    return "A" if average >= 70 else "B" if average >= 60 else "C"


def describe_spec(motor: float, aero: float, grip: float) -> dict:
    """The part manifest for a given development state — drives the model."""
    mT, aT, gT = tier_of(motor), tier_of(aero), tier_of(grip)
    return {
        "tiers": {"motor": mT, "aero": aT, "grip": gT},
        "spec": spec_letter((motor + aero + grip) / 3),
        # Every tier step has to be readable on a phone-sized render, so each
        # one adds at least one silhouette-level change, not just a detail.
        "parts": {
            # MOTOR — the back of the car.
            "exhaust": mT >= 2,             # T1 has no visible pipe at all
            "airbox_scoop": mT >= 2,        # taller intake lip over the roll hoop
            "energy_pods": mT >= 2,         # 2026 battery cooling ducts on the flanks
            "exhaust_large": mT >= 3,
            "exhaust_glow": mT >= 3,        # hot accent tip
            "heat_haze": mT >= 3,
            "engine_louvres": mT >= 3,
            "cooling_gills": mT >= 3,       # accent gill slots on the engine cover
            "power_spine": mT >= 3,         # accent spine down the cover
            # AERO — the wings.
            "front_flap_2": aT >= 2,
            "front_flap_3": aT >= 3,
            "active_aero": aT >= 3,         # 2026 X-mode: front + rear flaps go flat
            "rear_flap": aT >= 2,           # T1 runs a single-element rear wing
            "beam_wing": aT >= 2,
            "floor_edge_wing": aT >= 2,
            "rear_drs_open": aT >= 3,
            "rear_endplate_tall": aT >= 3,  # T1 short, T2 medium, T3 tall + accent strip
            "bargeboards": aT >= 2,
            "shark_fin": aT >= 3,
            "t_wing": aT >= 3,
            "endplate_lips": aT >= 3,
            "mirror_winglets": aT >= 3,
            # GRIP — wheels and floor.
            "compound_band": True,
            "wide_tyres": gT >= 2,
            "rim_ring": gT >= 2,            # accent ring on the wheel cover
            "brake_ducts": gT >= 2,         # winglets on the front uprights
            "diffuser_strakes": gT >= 3,
            "big_diffuser": gT >= 3,
            "rim_upgrade": gT >= 3,         # cover takes the accent colour
        },
    }
