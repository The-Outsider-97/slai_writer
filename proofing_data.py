"""Reference data for Writer's proofreading layer (``proofing.py``). Plain data, no logic.

Everything here exists because a measured failure needed it, and is small enough to read: words that SLAI's English word list lacks, the words people
actually write most (used only to rank suggestions), irregular verbs, and the American / British spelling pairs.
"""
from __future__ import annotations

# --- words missing from SLAI's English word list that people use every day ("timeline" was flagged as a spelling error). ---------------------------------
SUPPLEMENT_EN = """
timeline timelines email emails online offline website websites webpage webpages internet blog blogs podcast podcasts smartphone smartphones app apps
login logins logout username usernames password passwords wifi bluetooth download downloads upload uploads database databases software hardware
cybersecurity startup startups workflow workflows teamwork roadmap roadmaps stakeholder stakeholders benchmark benchmarks dataset datasets
backend frontend plugin plugins dropdown checkbox checkboxes toolbar toolbars sidebar sidebars popup popups screenshot screenshots livestream
metadata namespace namespaces lifecycle workspace workspaces proofread proofreading proofreader autosave filename filenames
sci-fi biotech nanotech fintech healthtech edtech covid coronavirus ebook ebooks emoji emojis selfie selfies hashtag hashtags
unfollow username microservice microservices frontend multitasking brainstorm brainstorming rebrand rebranding upskilling reskilling
cooperative collaboratively timeframe timeframes deadline deadlines checklist checklists template templates
tooltip tooltips scrollbar scrollbars serializer serializers serialize serialise deserialize deserialise validator validators repo repos config configs keyframe keyframes
rasterize rasterise rasterizer rasterizers stdout stdin stderr hyperlink hyperlinks signup signups timestamp timestamps bitmap bitmaps codec codecs async regex regexes lookup lookups
checkpoint checkpoints runtime runtimes middleware webhook webhooks localhost hostname hostnames subfolder subfolders subdirectory textbox textboxes wireframe wireframes
whitespace hotkey hotkeys shortcut shortcuts backup backups autocomplete preprocess postprocess reload reloads refactor refactors parser parsers tokenizer tokenizers
readme readmes changelog changelogs unmarshal recents favicon favicons thumbnail thumbnails dropdowns pixelated vectorize vectorise rasterised clipart
codebase codebases dev devs frontends backends offsets offset rollout rollouts rollback rollbacks toggle toggles toggled uninstall uninstalls uninstalled
""".split()

# --- the most common English words: used ONLY to prefer them among equally close spelling suggestions. ----------------------------------------------------
COMMON_EN = """
the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what
so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now
look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been
being has had did does done said says went gone made makes found find told tell asked ask seem seems seemed feel felt try tried leave left call called
need needs needed become became begin began begun show showed shown hear heard play played run ran move moved live lived believe believed hold held
bring brought happen happened write wrote written provide provided sit sat stand stood lose lost pay paid meet met include included continue continued
set learn learned change changed lead led understand understood watch watched follow followed stop stopped create created speak spoke spoken read allow
allowed add added spend spent grow grew grown open opened walk walked win won offer offered remember remembered love loved consider considered appear
appeared buy bought wait waited serve served die died send sent expect expected build built stay stayed fall fell cut reach reached kill killed remain
remained suggest suggested raise raised pass passed sell sold require required report reported decide decided pull pulled
man woman child children world life hand part place case week company system program question government number night point home water room mother
area money story fact month lot right study book eye job word business issue side kind head house service friend father power hour game line end member
law car city community name president team minute idea kid body information back parent face others level office door health person art war history
party result change morning reason research girl guy moment air teacher force education foot boy age policy music market sense nation plan college
interest death experience effect use class control care field development role effort rate heart drug show leader light voice wife police mind price
report decision son view relationship town road arm difference value building action model season society tax director position player record paper
space ground form event official matter center couple site project activity star table need court oil situation cost industry figure street image
phone data picture practice piece land product doctor wall patient worker news test movie north love support technology step baby computer type
attention film tree source organization hair window culture chance brother energy period course summer plant opportunity term letter condition choice
good new first last long great little own other old right big high different small large next early young important few public bad same able
timeline premise premises vol volume chapter section paragraph sentence document documents editor writer reader author title heading margin page pages
text font style format table figure caption reference citation footnote index summary introduction conclusion appendix abstract
very really always never often sometimes usually already still again once here where why while before after during between against without within
through under above below across along around behind beyond inside outside toward towards until upon among
convinced convince convincing control controls controlled controlling premise premises
""".split()

# --- irregular verbs: base, past, participle -----------------------------------------------------------------------------------------------------
IRREGULAR = {
    "be": ("was", "been"), "become": ("became", "become"), "begin": ("began", "begun"), "bring": ("brought", "brought"), "buy": ("bought", "bought"),
    "choose": ("chose", "chosen"), "come": ("came", "come"), "do": ("did", "done"), "draw": ("drew", "drawn"), "drink": ("drank", "drunk"),
    "drive": ("drove", "driven"), "eat": ("ate", "eaten"), "fall": ("fell", "fallen"), "feel": ("felt", "felt"), "find": ("found", "found"),
    "fly": ("flew", "flown"), "forget": ("forgot", "forgotten"), "get": ("got", "got"), "give": ("gave", "given"), "go": ("went", "gone"),
    "grow": ("grew", "grown"), "have": ("had", "had"), "hear": ("heard", "heard"), "hold": ("held", "held"), "keep": ("kept", "kept"),
    "know": ("knew", "known"), "leave": ("left", "left"), "lose": ("lost", "lost"), "make": ("made", "made"), "meet": ("met", "met"),
    "pay": ("paid", "paid"), "read": ("read", "read"), "ride": ("rode", "ridden"), "run": ("ran", "run"), "say": ("said", "said"), "see": ("saw", "seen"),
    "sell": ("sold", "sold"), "send": ("sent", "sent"), "sing": ("sang", "sung"), "sit": ("sat", "sat"), "speak": ("spoke", "spoken"),
    "spend": ("spent", "spent"), "stand": ("stood", "stood"), "take": ("took", "taken"), "teach": ("taught", "taught"), "tell": ("told", "told"),
    "think": ("thought", "thought"), "throw": ("threw", "thrown"), "understand": ("understood", "understood"), "wear": ("wore", "worn"),
    "win": ("won", "won"), "write": ("wrote", "written"), "break": ("broke", "broken"), "build": ("built", "built"), "catch": ("caught", "caught"),
    "fight": ("fought", "fought"), "hide": ("hid", "hidden"), "lead": ("led", "led"), "put": ("put", "put"), "set": ("set", "set"), "swim": ("swam", "swum"),
}
# regular verbs that are common enough for the agreement and tense rules (they take -s / -es / -ies and -ed)
REGULAR_VERBS = """
accept add agree allow appear ask believe call care carry change check claim close consider continue control convince count create decide deliver
depend describe design develop direct discuss enjoy enter expect explain fail fix follow happen help hope improve include increase intend join jump
kill learn like listen live look love manage matter mean move need notice offer open order own pass perform plan play prefer prepare produce promise
protect provide pull push reach realize receive record reduce remain remember remove repeat replace report represent require respond return reveal
save serve share show start stay stop study suggest support talk test thank touch travel treat try turn use visit wait walk want watch work worry
""".split()

# --- US / UK spelling pairs (US -> UK) ---------------------------------------------------------------------------------------------------------------
US_UK = {
    "color": "colour", "colors": "colours", "colored": "coloured", "favorite": "favourite", "favorites": "favourites", "honor": "honour", "honors": "honours",
    "humor": "humour", "labor": "labour", "neighbor": "neighbour", "neighbors": "neighbours", "behavior": "behaviour", "behaviors": "behaviours",
    "flavor": "flavour", "harbor": "harbour", "rumor": "rumour", "vapor": "vapour", "center": "centre", "centers": "centres", "meter": "metre",
    "meters": "metres", "liter": "litre", "liters": "litres", "theater": "theatre", "theaters": "theatres", "fiber": "fibre", "defense": "defence",
    "offense": "offence", "license": "licence", "pretense": "pretence", "gray": "grey", "jewelry": "jewellery", "catalog": "catalogue", "dialog": "dialogue",
    "program": "programme", "analyze": "analyse", "analyzed": "analysed", "analyzing": "analysing", "paralyze": "paralyse", "organize": "organise",
    "organized": "organised", "organizing": "organising", "organization": "organisation", "organizations": "organisations", "realize": "realise",
    "realized": "realised", "realizing": "realising", "recognize": "recognise", "recognized": "recognised", "apologize": "apologise",
    "apologized": "apologised", "criticize": "criticise", "emphasize": "emphasise", "emphasized": "emphasised", "summarize": "summarise",
    "summarized": "summarised", "specialize": "specialise", "authorize": "authorise", "authorized": "authorised", "minimize": "minimise",
    "maximize": "maximise", "optimize": "optimise", "optimized": "optimised", "customize": "customise", "customized": "customised",
    "standardize": "standardise", "utilize": "utilise", "visualize": "visualise", "capitalize": "capitalise", "categorize": "categorise",
    "generalize": "generalise", "finalize": "finalise", "normalize": "normalise", "prioritize": "prioritise", "initialize": "initialise",
    "traveler": "traveller", "traveled": "travelled", "traveling": "travelling", "canceled": "cancelled", "canceling": "cancelling", "modeling": "modelling",
    "modeled": "modelled", "labeled": "labelled", "labeling": "labelling", "fueled": "fuelled", "signaled": "signalled", "counselor": "counsellor",
    "aluminum": "aluminium", "artifact": "artefact", "check": "cheque", "curb": "kerb", "draft": "draught", "mold": "mould", "plow": "plough",
    "skeptic": "sceptic", "sulfur": "sulphur", "tire": "tyre", "pajamas": "pyjamas", "mom": "mum", "enrollment": "enrolment", "fulfill": "fulfil",
    "judgment": "judgement", "acknowledgment": "acknowledgement", "aging": "ageing", "maneuver": "manoeuvre", "orthopedic": "orthopaedic",
    "anesthesia": "anaesthesia", "esthetic": "aesthetic", "fetus": "foetus", "diarrhea": "diarrhoea", "encyclopedia": "encyclopaedia",
}
# words where the two forms are a real choice between two different words (never flag): check/cheque is a noun/verb choice, program is a word in both,
# draft is a word in both, license is a verb in UK English, practice/practise likewise.
US_UK_AMBIGUOUS = {"check", "program", "draft", "license", "meter", "mom"}

# --- names of letters that start with a vowel sound (an FBI, an MRI, an SMS, an LED, an HTML), and acronyms read as words (a NASA, a UNESCO) -----------------
VOWEL_LETTERS = set("AEFHILMNORSX")
ACRONYM_AS_WORD = {"NASA", "NATO", "UNESCO", "UNICEF", "OPEC", "LASER", "RADAR", "SCUBA", "AIDS", "ASAP", "FIFA", "UEFA", "SWAT", "NAFTA", "ASEAN", "OSHA", "ACME"}
ACRONYM_SPELLED = {"URL", "UI", "UX", "UK", "US", "USA", "UN", "EU", "UAE", "USB", "UML", "UTC", "UV", "EEG", "ECG", "FAQ", "FBI", "HTML", "HTTP", "LED", "MBA", "MRI",
                   "MP", "NGO", "SMS", "SQL", "SSL", "XML", "RSVP", "HR", "IP", "IT", "AI", "API", "OK", "ID", "IQ", "LCD", "MSc", "MA", "NHS", "SOS", "FM", "AM"}

# --- a / an exceptions by pronunciation (first-sound), lowercase prefixes ---------------------------------------------------------------------------------
A_BEFORE_VOWEL_LETTER = ("uni", "use", "usu", "uti", "uri", "uro", "eu", "one", "once", "ubiq", "ufo", "uk", "ura", "uran", "urol", "euro", "ewe", "ukulele", "unanim",
                         "unic", "unif", "unil", "unim", "union", "uniq", "unit", "univ", "usab", "usag", "user", "usual", "util", "utop", "uvul", "eulog", "euph")
AN_BEFORE_CONSONANT_LETTER = ("hour", "honest", "honor", "honour", "heir", "herb", "homage", "hono")

# --- confusions that are wrong in (nearly) every context --------------------------------------------------------------------------------------------------
SIMPLE_PHRASES = [
    # (regex on lower-cased text, replacement, message, rule)
    (r"\b(should|could|would|must|might) of\b", r"\1 have", "“of” sounds like “have” after a modal verb, but the verb needed here is “have”.", "modal-of"),
    (r"\balot\b", "a lot", "“a lot” is two words.", "alot"),
    (r"\bto (much|many)\b", r"too \1", "Use “too” (meaning more than enough), not “to”.", "to-too"),
    (r"\b(depend|depends|depended|depending) of\b", r"\1 on", "The preposition after “depend” is “on”.", "depend-on"),
    (r"\b(discuss|discusses|discussed|discussing) about\b", r"\1", "“Discuss” takes its object directly: no “about”.", "discuss-about"),
    (r"\b(emphasi[sz]e|emphasi[sz]es|emphasi[sz]ed) on\b", r"\1", "“Emphasize” takes its object directly: no “on”.", "emphasize-on"),
    (r"\bmore (better|easier|faster|bigger|smaller|larger|worse|harder|cheaper)\b", r"\1", "A comparative like this one already means “more”.", "double-comparative"),
    (r"\bmost (easiest|fastest|biggest|smallest|largest|hardest|cheapest|best|worst)\b", r"\1", "A superlative like this one already means “most”.", "double-superlative"),
    (r"\b(their) (is|are|was|were)\b", r"there \2", "“There” (not “their”) introduces something that exists.", "there-their"),
    (r"\bless (people|things|items|books|cars|words|mistakes|errors)\b", r"fewer \1", "Use “fewer” with things you can count.", "less-fewer"),
    (r"\bi\.e\b(?!\.)", "i.e.", "The abbreviation ends with a full stop.", "ie-dot"),
    (r"\b(irregardless)\b", "regardless", "“Regardless” is the standard word.", "irregardless"),
    (r"\bfor all intensive purposes\b", "for all intents and purposes", "The idiom is “for all intents and purposes”.", "intents"),
]

# --- style: optional improvements, never counted as errors -------------------------------------------------------------------------------------------
STYLE_PHRASES = [
    (r"\bin order to\b", "to", "Often just “to” says the same thing.", "wordy-in-order-to"),
    (r"\bdue to the fact that\b", "because", "“Because” says the same thing in fewer words.", "wordy-due-to-fact"),
    (r"\bat this point in time\b", "now", "“Now” says the same thing in fewer words.", "wordy-point-in-time"),
    (r"\bin the event that\b", "if", "“If” says the same thing in fewer words.", "wordy-in-the-event"),
    (r"\bit is important to note that\b", "", "Usually the sentence works without this lead-in.", "wordy-note-that"),
    (r"\b(each and every)\b", "every", "“Every” is enough.", "wordy-each-and-every"),
    (r"\bvery unique\b", "unique", "“Unique” cannot be modified: something is unique or it is not.", "very-unique"),
]

# --- Dutch / English function words, to notice text in another language than the document's ------------------------------------------------------------
STOP_EN = set("the of and to in is that it was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know".split())
STOP_NL = set("de het een en van ik te dat die in is niet zijn op aan met als voor had er maar om hem dan zou of wat mijn men dit zo ze zich nog ook naar bij uit wel wij haar kan door over hij je ons nu ben heeft geen werd worden toen tot veel meer doen weer waar zij hun hebben deze onder alleen hoe dus zelf andere iets want al wordt jaar kunnen moet zeggen".split())


# --- misspellings that SLAI's English list contains as if they were words (found by checking a list of common typos against it), with the right word ----------------
MISSPELLINGS = {
    "wich": "which", "accomodate": "accommodate", "accomodation": "accommodation", "acheive": "achieve", "acheived": "achieved", "adress": "address",
    "agressive": "aggressive", "apparant": "apparent", "appearence": "appearance", "arguement": "argument", "basicly": "basically",
    "begining": "beginning", "beleive": "believe", "belive": "believe", "buisness": "business", "calender": "calendar", "catagory": "category",
    "cemetary": "cemetery", "collegue": "colleague", "comming": "coming", "commitee": "committee", "completly": "completely",
    "concious": "conscious", "definately": "definitely", "definatly": "definitely", "dissapoint": "disappoint", "embarass": "embarrass",
    "enviroment": "environment", "existance": "existence", "familar": "familiar", "finaly": "finally", "foriegn": "foreign", "freind": "friend",
    "goverment": "government", "gaurd": "guard", "happend": "happened", "harrass": "harass", "immediatly": "immediately",
    "independant": "independent", "interupt": "interrupt", "knowlege": "knowledge", "liason": "liaison", "libary": "library",
    "maintainance": "maintenance", "millenium": "millennium", "mispell": "misspell", "neccessary": "necessary", "necesary": "necessary",
    "noticable": "noticeable", "occassion": "occasion", "occured": "occurred", "occurence": "occurrence", "persistant": "persistent",
    "posession": "possession", "prefered": "preferred", "publically": "publicly", "realy": "really", "recieve": "receive", "reccomend": "recommend",
    "recomend": "recommend", "refered": "referred", "relevent": "relevant", "religous": "religious", "remeber": "remember",
    "resistence": "resistance", "responsability": "responsibility", "seperate": "separate", "sieze": "seize", "succesful": "successful",
    "succesfully": "successfully", "sucess": "success", "supercede": "supersede", "tommorow": "tomorrow", "truely": "truly", "untill": "until",
    "wierd": "weird", "writting": "writing", "yeild": "yield", "thier": "their", "teh": "the", "recive": "receive", "adn": "and", "taht": "that",
    "becuase": "because", "beacuse": "because", "definitly": "definitely", "diffrent": "different", "diferent": "different", "dosent": "doesn't",
    "tounge": "tongue", "tyrany": "tyranny", "vaccum": "vacuum", "vegtable": "vegetable", "wether": "whether", "whereever": "wherever",
    "accross": "across", "aquire": "acquire", "athiest": "atheist", "bizzare": "bizarre", "changable": "changeable", "dilema": "dilemma",
    "discription": "description", "dissapear": "disappear", "equiptment": "equipment", "excercise": "exercise", "existant": "existent",
    "fourty": "forty", "garantee": "guarantee", "grammer": "grammar", "heighth": "height", "hierachy": "hierarchy", "ignorence": "ignorance",
    "intresting": "interesting", "lenght": "length", "lisence": "license", "mischevious": "mischievous", "neice": "niece", "ocasion": "occasion",
    "oppurtunity": "opportunity", "paralel": "parallel", "parliment": "parliament", "percieve": "perceive", "plagerize": "plagiarize",
    "priviledge": "privilege", "pronounciation": "pronunciation", "questionaire": "questionnaire", "rediculous": "ridiculous", "rythm": "rhythm",
    "sargent": "sergeant", "scedule": "schedule", "sentance": "sentence", "speach": "speech", "strenght": "strength", "suprise": "surprise",
    "temperture": "temperature", "threshhold": "threshold", "transfered": "transferred", "underate": "underrate", "vicous": "vicious",
    "visable": "visible", "wellfare": "welfare", "wensday": "wednesday", "withold": "withhold", "writen": "written", "seperately": "separately",
    "accidently": "accidentally", "amature": "amateur", "adviced": "advised", "bussiness": "business", "compareing": "comparing",
    "comparision": "comparison", "concensus": "consensus", "developement": "development", "enterance": "entrance", "embarassing": "embarrassing",
    "gratefull": "grateful", "hapiness": "happiness", "occuring": "occurring", "ommit": "omit", "ocurred": "occurred", "ocurrence": "occurrence",
    "recomendation": "recommendation", "reciept": "receipt", "sucessful": "successful", "surprize": "surprise", "thankyou": "thank you",
    "aswell": "as well", "alot": "a lot", "eachother": "each other", "infact": "in fact", "atleast": "at least", "incase": "in case",
}
