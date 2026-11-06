"""The categories shown in the app's dropdown, and the problems in each.

Problems are grouped by what the caller is reporting, not by which agency
handles it. Every problem belongs to exactly one category, in display order.
"""

PROBLEM_GROUPS = {
    "Air & Health Hazards": [
        "Air Quality", "Asbestos", "Beach/Pool/Sauna Complaint",
        "Construction Lead Dust", "Cooling Tower", "Hazardous Materials",
        "Indoor Air Quality", "Lifeguard", "Mold", "Oil or Gas Spill",
        "Poison Ivy", "Radioactive Material", "Smoking or Vaping",
        "Standing Water", "X-Ray Machine/Equipment",
    ],
    "Animals & Pests": [
        "Animal Facility - No Permit", "Animal in a Park", "Animal-Abuse",
        "Dead Animal", "Harboring Bees/Wasps", "Illegal Animal Kept as Pet",
        "Illegal Animal Sold", "Mosquitoes", "Pet Sale", "Rodent",
        "Trapping Pigeon", "Unleashed Dog", "Unsanitary Animal Facility",
        "Unsanitary Animal Pvt Property", "Unsanitary Pigeon Condition",
    ],
    "Buildings & Construction": [
        "AHV Inspection Unit", "BEST/Site Safety", "Boilers", "Borough Office",
        "Building Condition", "Building Marshal's Office",
        "Building Marshals office", "Building/Use",
        "Construction Safety Enforcement", "Cranes and Derricks",
        "Dept of Investigations", "Electrical", "Elevator",
        "Emergency Response Team (ERT)", "General Construction/Plumbing",
        "Investigations and Discipline (IAD)", "Non-Residential Heat",
        "Real Time Enforcement", "Scaffold Safety", "School Maintenance",
        "Special Natural Area District (SNAD)", "Special Operations",
        "Special Projects Inspection Team (SPIT)",
    ],
    "Businesses & Vendors": [
        "Calorie Labeling", "Cannabis Retailer", "Consumer Complaint",
        "Day Care", "Food Establishment", "Food Poisoning",
        "Mobile Food Vendor", "Outdoor Dining", "Tanning", "Tattooing",
        "Tobacco or Non-Tobacco Sale", "Vendor Enforcement",
    ],
    "Housing Conditions": [
        "APPLIANCE", "DOOR/WINDOW", "ELECTRIC", "FLOORING/STAIRS", "GENERAL",
        "HEAT/HOT WATER", "OUTSIDE BUILDING", "PAINT/PLASTER", "PLUMBING",
        "SAFETY", "UNSANITARY CONDITION", "WATER LEAK", "Window Guard",
    ],
    "Noise": [
        "Noise", "Noise - Commercial", "Noise - Helicopter",
        "Noise - House of Worship", "Noise - Park", "Noise - Residential",
        "Noise - Street/Sidewalk", "Noise - Vehicle",
    ],
    "Parking & Traffic": [
        "Abandoned Bike", "Abandoned Vehicle", "Bike/Roller/Skate",
        "Bike/Roller/Skate Chronic", "Blocked Driveway",
        "Broken Parking Meter", "Derelict Vehicles", "E-Scooter",
        "Illegal Parking", "Municipal Parking Facility", "Traffic",
    ],
    "Public Safety & Homelessness": [
        "Disorderly Youth", "Drinking", "Drug Activity", "Encampment",
        "Homeless Person Assistance", "Illegal Fireworks",
        "Non-Emergency Police Matter", "Panhandling", "Squeegee",
        "Urinating in Public",
    ],
    "Streets & Sidewalks": [
        "Bench", "Bike Rack", "Bridge Condition",
        "Bus Stop Shelter Complaint", "Bus Stop Shelter Placement",
        "Curb Condition", "DEP Highway Condition", "DEP Sidewalk Condition",
        "DEP Street Condition", "Highway Condition", "Highway Sign - Damaged",
        "Highway Sign - Dangling", "Highway Sign - Missing", "Leaning Bar",
        "LinkNYC", "Obstruction", "Public Payphone Complaint", "Public Toilet",
        "Sidewalk Condition", "Snow or Ice", "Street Condition",
        "Street Light Condition", "Street Sign - Damaged",
        "Street Sign - Dangling", "Street Sign - Missing",
        "Traffic Signal Condition", "Tunnel Condition", "Wayfinding",
    ],
    "Taxis & Ferries": [
        "FHV Licensee Complaint", "Ferry Complaint", "Ferry Inquiry",
        "For Hire Vehicle Complaint", "For Hire Vehicle Report",
        "Found Property", "Green Taxi Complaint", "Green Taxi Report",
        "Lost Property", "Taxi Complaint", "Taxi Compliment",
        "Taxi Licensee Complaint", "Taxi Report",
    ],
    "Trash & Cleanliness": [
        "Commercial Disposal Complaint", "Dirty Condition",
        "Dumpster Complaint", "Graffiti", "Illegal Dumping", "Illegal Posting",
        "Incorrect Data", "Institution Disposal Complaint",
        "Litter Basket Complaint", "Litter Basket Request", "Lot Condition",
        "Missed Collection", "Posting Advertisement",
        "Recycling Basket Complaint", "Residential Disposal Complaint",
        "Sanitation Worker or Vehicle Complaint", "Street Sweeping Complaint",
        "Transfer Station Complaint",
    ],
    "Trees & Parks": [
        "Damaged Tree", "Dead/Dying Tree", "Illegal Tree Damage",
        "Maintenance or Facility", "New Tree Request",
        "Overgrown Tree/Branches", "Root/Sewer/Sidewalk Condition",
        "Uprooted Stump", "Violation of Park Rules", "Wood Pile Remaining",
    ],
    "Water & Sewer": [
        "Building Drinking Water Tank", "Drinking Water", "Indoor Sewage",
        "Industrial Waste", "Lead", "Plant", "Sewer", "Water Conservation",
        "Water Quality", "Water System",
    ],
    "Other": ["DSNY Internal", "SNW", "Unspecified"],
}
