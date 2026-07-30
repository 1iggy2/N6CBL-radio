/* /tools/uav/ — fixed-wing UAV design lab.
 *
 * Architecture (kept deliberately framework-shaped so the tool can grow):
 *   PARAMS   — registry of every design input: bounds, units, defaults, groups,
 *              and a physics explainer. The form, the design file, the Monte
 *              Carlo sampler, the sensitivity table, and the parameter
 *              reference all read this registry; adding a parameter here wires
 *              it in everywhere.
 *   AIRFOILS — 2-D section database (RC-Reynolds polar summaries + shape params).
 *   PRESETS  — COTS component archetypes (airframes, motors, batteries) that
 *              write into PARAMS keys; specs are approximate class values.
 *   derive() — pure function: design → derived quantities. No DOM access, so
 *              search and sensitivity code can call it tens of thousands of times.
 *   METRICS  — registry of derived outputs: labels, units, formatting. Constraint
 *              and objective pickers are generated from PARAMS + METRICS, which is
 *              what makes "any parameter can be a constraint" hold.
 *   Views    — readouts, design checks, SVG 3-view, airfoil section, performance
 *              charts, sensitivity table, Monte Carlo scatter. All views
 *              re-render from one state.
 *   Design file — versioned JSON (n6cbl.uav-design/1) download/upload for
 *              save/resume; parameters only, derived values are recomputed.
 */
(function () {
  'use strict';

  var G = 9.80665;          // m/s^2
  var MU_AIR = 1.81e-5;     // Pa*s, dynamic viscosity of air at ~15 C
  var CELL_V = 3.7;         // nominal LiPo cell voltage
  var SCHEMA = 'n6cbl.uav-design/1';
  var STORE_KEY = 'n6cbl.uav.working';  // localStorage autosave slot (device-local, never sent anywhere)
  var DASH = '—';

  /* ── airfoil database ─────────────────────────────────────────────────
   * 2-D section values summarized from published low-Reynolds polars
   * (UIUC LSATs / Airfoil Tools, Re ≈ 100k–400k). cla is per radian.
   * camber/camberPos/thickness (% chord) drive the drawn section, which is a
   * NACA-4-digit-style reconstruction — exact for NACA foils, an approximation
   * for the rest (labeled as such on the figure).
   */
  var AIRFOILS = {
    clarky:   { label: 'Clark Y',        camber: 3.4, camberPos: 42, thickness: 11.7, cl0: 0.38, cla: 6.0, clmax: 1.35, cd0: 0.0100, cm: -0.085, use: 'classic trainer / general sport' },
    naca2412: { label: 'NACA 2412',      camber: 2.0, camberPos: 40, thickness: 12.0, cl0: 0.25, cla: 6.1, clmax: 1.25, cd0: 0.0090, cm: -0.050, use: 'general purpose, docile stall' },
    naca4412: { label: 'NACA 4412',      camber: 4.0, camberPos: 40, thickness: 12.0, cl0: 0.45, cla: 6.0, clmax: 1.45, cd0: 0.0100, cm: -0.100, use: 'high lift, slow flyers / payload' },
    naca0012: { label: 'NACA 0012',      camber: 0.0, camberPos: 30, thickness: 12.0, cl0: 0.00, cla: 6.1, clmax: 1.10, cd0: 0.0080, cm:  0.000, use: 'symmetric — aerobats, tails' },
    sd7037:   { label: 'SD7037',         camber: 3.0, camberPos: 42, thickness:  9.2, cl0: 0.35, cla: 6.2, clmax: 1.30, cd0: 0.0080, cm: -0.070, use: 'sailplane workhorse' },
    e205:     { label: 'Eppler E205',    camber: 3.0, camberPos: 40, thickness: 10.5, cl0: 0.25, cla: 6.1, clmax: 1.15, cd0: 0.0080, cm: -0.050, use: 'sailplane, wide speed range' },
    ag35:     { label: 'AG35',           camber: 2.3, camberPos: 38, thickness:  8.7, cl0: 0.25, cla: 6.2, clmax: 1.10, cd0: 0.0070, cm: -0.060, use: 'F3-class glider, low drag' },
    mh32:     { label: 'MH32',           camber: 2.4, camberPos: 40, thickness:  8.7, cl0: 0.25, cla: 6.2, clmax: 1.15, cd0: 0.0070, cm: -0.060, use: 'fast glider / electric sport' },
    s1223:    { label: 'Selig S1223',    camber: 8.1, camberPos: 49, thickness: 12.1, cl0: 1.00, cla: 5.9, clmax: 2.10, cd0: 0.0150, cm: -0.250, use: 'max lift — heavy-payload lifters' },
    mh45:     { label: 'MH45 (reflexed)', camber: 1.6, camberPos: 40, thickness:  9.9, cl0: 0.15, cla: 6.0, clmax: 1.05, cd0: 0.0080, cm:  0.000, use: 'flying wings — near-zero pitching moment' },
    mh60:     { label: 'MH60 (reflexed)', camber: 1.5, camberPos: 38, thickness: 10.1, cl0: 0.12, cla: 6.0, clmax: 1.00, cd0: 0.0085, cm:  0.005, use: 'flying wing workhorse, docile' },
    flat:     { label: 'Flat plate',     camber: 0.0, camberPos: 30, thickness:  3.0, cl0: 0.00, cla: 5.5, clmax: 0.80, cd0: 0.0200, cm:  0.000, use: 'foamboard / park flyer baseline' }
  };

  var TAIL_TYPES = {
    conventional: { label: 'Conventional' },
    ttail:        { label: 'T-tail' },
    vtail:        { label: 'V-tail' },
    flyingwing:   { label: 'Flying wing / BWB' }
  };

  // parameters the model ignores for a given configuration (flying wings have
  // no tail surfaces — stability comes from sweep, washout, and section cm)
  var FLYING_WING_IRRELEVANT = { tailArm: 1, vh: 1, vv: 1, arH: 1, arV: 1, tailTaper: 1 };
  function paramRelevant(key, d) {
    if (d.tailType === 'flyingwing' && FLYING_WING_IRRELEVANT[key]) return false;
    return true;
  }

  /* ── parameter registry ──────────────────────────────────────────────── */
  var PARAMS = [
    // wing + fuselage geometry
    { key: 'span',        group: 'geometry', label: 'Wing span',          unit: 'm',     def: 1.50,  min: 0.30,  max: 8.0,   step: 0.01,
      teach: 'Primary driver of induced drag through aspect ratio: at fixed weight and speed, induced drag scales with 1/b². More span means a flatter glide and slower roll response, and the structural bending moment at the root grows with it.' },
    { key: 'rootChord',   group: 'geometry', label: 'Root chord',         unit: 'm',     def: 0.24,  min: 0.05,  max: 2.0,   step: 0.005,
      teach: 'With span and taper this sets wing area, hence wing loading and stall speed. Bigger chord also raises the Reynolds number, which improves airfoil behavior at RC scale.' },
    { key: 'taper',       group: 'geometry', label: 'Taper ratio',        unit: 'tip/root', def: 0.70, min: 0.25, max: 1.0,  step: 0.01,
      teach: 'Tip chord over root chord. Moderate taper approaches the elliptical lift distribution (better span efficiency e), but small tips run low Reynolds numbers and stall first — the classic tip-stall trade.' },
    { key: 'sweepLE',     group: 'geometry', label: 'LE sweep',           unit: 'deg',   def: 0,     min: 0,     max: 35,    step: 0.5,
      teach: 'At model speeds sweep is not about compressibility: it moves the aerodynamic center aft and adds effective dihedral. Mostly a CG-range, stability, and styling decision.' },
    { key: 'dihedral',    group: 'geometry', label: 'Dihedral',           unit: 'deg',   def: 3,     min: 0,     max: 12,    step: 0.5,
      teach: 'Tilting the panels up gives roll stability: in a sideslip the low wing meets the air at higher effective angle of attack and rolls the aircraft level. Traded against roll agility — aerobats fly near zero.' },
    { key: 'fusLength',   group: 'geometry', label: 'Fuselage length',    unit: 'm',     def: 1.00,  min: 0.20,  max: 6.0,   step: 0.01,
      teach: 'Sets wetted area (skin-friction drag) and how far aft the tail can sit. A longer fuselage costs drag but buys tail arm, which buys stability per gram of tail.' },
    { key: 'fusDiameter', group: 'geometry', label: 'Fuselage diameter',  unit: 'm',     def: 0.09,  min: 0.02,  max: 1.00,  step: 0.005,
      teach: 'Drives fuselage wetted area and the internal volume available for battery and payload. Parasite drag grows roughly linearly with diameter at fixed length.' },
    { key: 'cgMac',       group: 'geometry', label: 'CG position',        unit: '% MAC', def: 30,    min: 10,    max: 45,    step: 0.5,
      teach: 'Where the mass balances along the mean chord. CG ahead of the neutral point = stable; the gap between them is the static margin. The single most important number to get right before a first flight.' },
    // tail geometry
    { key: 'tailType',    group: 'tail',     label: 'Tail configuration', unit: 'layout', def: 'conventional', options: TAIL_TYPES,
      teach: 'Conventional is easiest to build and trim. A T-tail lifts the stabilizer out of the wing downwash (modeled here as a reduced downwash derivative) at a structural cost. A V-tail merges both surfaces into two panels — less wetted area and parts, but requires ruddervator mixing and couples pitch/yaw. A flying wing/BWB deletes the tail entirely: least drag and structure, but trim must come from sweep, washout, and a reflexed (near-zero cm) section, static margins shrink to 3–8 %, and the tail parameters below stop mattering.' },
    { key: 'tailArm',     group: 'tail',     label: 'Tail arm (c/4→c/4)', unit: 'm', def: 0.58, min: 0.15,  max: 5.0,   step: 0.01,
      teach: 'Lever arm from wing quarter-chord to tail quarter-chord. Tail effectiveness scales with arm × area, so a longer arm delivers the same stability with a smaller, lighter, lower-drag tail.' },
    { key: 'vh',          group: 'tail',     label: 'H-tail volume Vₕ', unit: '-',  def: 0.50,  min: 0.25,  max: 0.90,  step: 0.01,
      teach: 'Horizontal tail volume coefficient Vₕ = Sₕ·Lₜ/(S·MAC) — the classic similarity number for pitch stability. Trainers run ≈ 0.5–0.7, aerobats lower, powered gliders ≈ 0.4–0.5.' },
    { key: 'vv',          group: 'tail',     label: 'V-tail volume Vᵥ', unit: '-',  def: 0.035, min: 0.015, max: 0.080, step: 0.001,
      teach: 'Vertical tail volume Vᵥ = Sᵥ·Lₜ/(S·b) — yaw stiffness, the "weathervane" authority. 0.02–0.05 covers most conventional layouts; more for short fuselages and pusher props.' },
    { key: 'arH',         group: 'tail',     label: 'H-tail aspect ratio', unit: '-', def: 4.0,  min: 2.0,   max: 7.0,   step: 0.1,
      teach: 'Aspect ratio of the tailplane (V-tail: of the combined panels). Higher AR steepens the tail lift-curve slope — more stabilizing power per unit area — but leaves the tail itself less stall margin.' },
    { key: 'arV',         group: 'tail',     label: 'Fin aspect ratio',   unit: '-', def: 1.5,  min: 0.8,   max: 3.0,   step: 0.1,
      teach: 'Fin height squared over fin area. Tall slender fins bite cleaner air and are more effective per area; short wide fins are stiffer and tolerate prop wash and grass landings better.' },
    { key: 'tailTaper',   group: 'tail',     label: 'Tail taper ratio',   unit: 'tip/root', def: 0.7, min: 0.4, max: 1.0, step: 0.05,
      teach: 'Tip/root chord of the tail surfaces. At this model fidelity it mainly shapes the drawn planform and the tail tip Reynolds number; structurally it lightens the tip.' },
    // aerodynamics
    { key: 'airfoil',     group: 'aero',     label: 'Wing airfoil',       unit: 'section', def: 'clarky', options: AIRFOILS,
      teach: 'The section sets how much lift the wing can generate (cl max → stall speed), its zero-lift drag floor, and its pitching moment — the nose-down torque the tail must continuously trim out.' },
    { key: 'oswald',      group: 'aero',     label: 'Oswald efficiency e', unit: '-',    def: 0.80,  min: 0.50,  max: 0.95,  step: 0.01,
      teach: 'Span-efficiency factor in the induced-drag term CL²/(π·e·AR). A perfect elliptical loading is e = 1; real monoplanes run 0.7–0.9. Planform taper, washout, and tip treatment move it.' },
    // mass budget
    { key: 'structure',   group: 'mass',     label: 'Structure mass',     unit: 'g',     def: 420,   min: 20,    max: 60000, step: 5,
      teach: 'Airframe: wing, fuselage, tail, gear. On built aircraft it typically runs 35–50 % of all-up weight. Every gram here compounds — it raises wing loading, which raises stall speed and power required.' },
    { key: 'payload',     group: 'mass',     label: 'Payload mass',       unit: 'g',     def: 200,   min: 0,     max: 50000, step: 5,
      teach: 'The mission: camera, sensor, cargo. The aircraft exists to carry this — good practice is to size the airframe around the payload, not squeeze the payload into an airframe.' },
    { key: 'avionics',    group: 'mass',     label: 'Avionics + servos',  unit: 'g',     def: 60,    min: 0,     max: 10000,  step: 5,
      teach: 'Receiver, servos, flight controller, GPS, wiring. Nearly constant across aircraft sizes, so it punishes small airframes disproportionately — one reason micros fly worse than their numbers suggest.' },
    { key: 'propMass',    group: 'mass',     label: 'Motor + ESC + prop', unit: 'g',     def: 130,   min: 0,     max: 25000,  step: 5,
      teach: 'The complete propulsion group mass. Scales roughly with max power (≈ 2–4 W per gram for hobby outrunners). The motor presets below fill realistic combos.' },
    // propulsion + battery
    { key: 'battCapacity',group: 'power',    label: 'Battery capacity',   unit: 'mAh',   def: 2200,  min: 100,   max: 200000, step: 50,
      teach: 'Energy on board grows linearly with capacity — and so does pack mass. Endurance therefore grows sub-linearly: each added cell of capacity also makes the aircraft heavier and hungrier.' },
    { key: 'battCells',   group: 'power',    label: 'Battery cells',      unit: 'S',     def: 3,     min: 1,     max: 14,    step: 1,
      teach: 'Series cells set pack voltage (3.7 V nominal each). Voltage decides which motor Kv is sensible and, with capacity, the total energy. Higher voltage moves the same power at lower current.' },
    { key: 'battDensity', group: 'power',    label: 'Pack energy density',unit: 'Wh/kg', def: 150,   min: 60,    max: 300,   step: 5,
      teach: 'Energy per kilogram of pack. LiPo ≈ 130–160 Wh/kg with high discharge rate; Li-ion ≈ 220–260 Wh/kg but limited current. The single biggest technology lever on endurance.' },
    { key: 'usableBatt',  group: 'power',    label: 'Usable capacity',    unit: 'fraction', def: 0.80, min: 0.50, max: 1.00, step: 0.01,
      teach: 'Fraction of capacity the mission may consume. 80 % protects LiPo cycle life and keeps a go-around reserve; Li-ion tolerates deeper discharge.' },
    { key: 'maxPower',    group: 'power',    label: 'Max electrical power', unit: 'W',   def: 350,   min: 5,     max: 50000, step: 5,
      teach: 'Full-throttle electrical draw. Through the efficiency chain it caps static thrust and climb rate, and sets how much of the power-required curve the aircraft can actually reach.' },
    { key: 'propDiameter',group: 'power',    label: 'Prop diameter',      unit: 'in',    def: 10,    min: 3,     max: 60,    step: 0.5,
      teach: 'A bigger disk makes more thrust per watt at low speed — actuator-disk physics: T ∝ (2ρA·P²)^⅓. Traded against ground clearance, RPM matching, and tip noise.' },
    { key: 'etaProp',     group: 'power',    label: 'Prop efficiency (cruise)', unit: '-', def: 0.55, min: 0.20, max: 0.90,  step: 0.01,
      teach: 'Fraction of shaft power that becomes thrust power at cruise. A well-matched prop near its design advance ratio reaches 0.6–0.7; a badly matched one silently wastes a third of the battery.' },
    { key: 'etaMotor',    group: 'power',    label: 'Motor + ESC efficiency', unit: '-', def: 0.85,  min: 0.50,  max: 0.98,  step: 0.01,
      teach: 'Electrical-to-shaft efficiency of motor plus ESC. Good outrunners near their sweet spot run 0.80–0.90; heavily loaded or badly Kv-matched motors fall well below and turn the loss into heat.' },
    // operating point
    { key: 'cruiseSpeed', group: 'ops',      label: 'Cruise speed',       unit: 'm/s',   def: 14,    min: 2,     max: 100,    step: 0.5,
      teach: 'The operating point for every cruise number on this page. Fly at the best-L/D speed to maximize range; fly slower, at the minimum-power speed (≈ 0.76 × V_LD), to maximize endurance.' },
    { key: 'altitude',    group: 'ops',      label: 'Field altitude',     unit: 'm MSL', def: 0,     min: 0,     max: 5000,  step: 50,
      teach: 'Air density falls about 1 % per 100 m. Thin air demands higher true airspeed for the same lift, robs the prop of static thrust, and slightly reduces drag.' }
  ];

  var GROUPS = [
    { id: 'geometry', label: 'Wing + fuselage geometry' },
    { id: 'tail',     label: 'Tail geometry' },
    { id: 'aero',     label: 'Aerodynamics' },
    { id: 'mass',     label: 'Mass budget' },
    { id: 'power',    label: 'Propulsion + battery' },
    { id: 'ops',      label: 'Operating point + environment' }
  ];

  /* ── COTS presets ─────────────────────────────────────────────────────
   * Approximate class values for common hobby hardware, labeled by size
   * class rather than brand. Applying a preset writes the listed PARAMS keys;
   * everything stays editable afterwards.
   */
  var PRESETS = {
    airframe: {
      label: 'Airframes',
      note: 'sets geometry, tail, airfoil, structure mass',
      items: [
        { id: 'micro800', label: '800 mm micro park flyer',
          info: 'foam · 0.13 m² · flat-plate wing',
          specs: { span: 0.80, rootChord: 0.16, taper: 0.90, sweepLE: 0, dihedral: 3, fusLength: 0.65, fusDiameter: 0.06, tailArm: 0.38, vh: 0.50, vv: 0.035, tailType: 'conventional', airfoil: 'flat', structure: 120 } },
        { id: 'ft1200', label: '1200 mm foamboard scratch build (FT-style)',
          info: 'flat foamboard · constant chord · cheap and crashable',
          specs: { span: 1.20, rootChord: 0.30, taper: 1.00, sweepLE: 0, dihedral: 2, fusLength: 0.90, fusDiameter: 0.10, tailArm: 0.55, vh: 0.50, vv: 0.035, tailType: 'conventional', airfoil: 'flat', structure: 400 } },
        { id: 'trainer1400', label: '1400 mm foam high-wing trainer (Apprentice-class)',
          info: 'molded foam · Clark Y · self-leveling dihedral',
          specs: { span: 1.40, rootChord: 0.23, taper: 0.85, sweepLE: 0, dihedral: 5, fusLength: 1.10, fusDiameter: 0.11, tailArm: 0.62, vh: 0.55, vv: 0.040, tailType: 'conventional', airfoil: 'clarky', structure: 780 } },
        { id: 'glider2000', label: '2000 mm powered sailplane (Radian-class)',
          info: 'slender pod · T-tail · thermal floater',
          specs: { span: 2.00, rootChord: 0.185, taper: 0.60, sweepLE: 0, dihedral: 6, fusLength: 1.15, fusDiameter: 0.065, tailArm: 0.70, vh: 0.45, vv: 0.030, tailType: 'ttail', airfoil: 'sd7037', structure: 480 } },
        { id: 'zagi900', label: '900 mm flying wing (Zagi / Z-84 class)',
          info: 'EPP slope/park wing · elevons · reflexed MH45',
          specs: { span: 0.90, rootChord: 0.28, taper: 0.50, sweepLE: 26, dihedral: 0, fusLength: 0.32, fusDiameter: 0.06, tailType: 'flyingwing', airfoil: 'mh45', structure: 260, cgMac: 20 } },
        { id: 'mapwing1100', label: '1100 mm mapping flying wing (eBee-class)',
          info: 'catapult/hand launch survey wing · camera bay pod',
          specs: { span: 1.10, rootChord: 0.30, taper: 0.45, sweepLE: 22, dihedral: 0, fusLength: 0.42, fusDiameter: 0.09, tailType: 'flyingwing', airfoil: 'mh60', structure: 420, cgMac: 20 } },
        { id: 'maptalon1300', label: '1300 mm mapping pusher (Mini Talon-class)',
          info: 'V-tail · pusher prop keeps the camera view clean',
          specs: { span: 1.30, rootChord: 0.20, taper: 0.75, sweepLE: 3, dihedral: 2, fusLength: 0.83, fusDiameter: 0.13, tailArm: 0.55, vh: 0.50, vv: 0.040, tailType: 'vtail', airfoil: 'mh32', structure: 650 } },
        { id: 'believer1960', label: '1960 mm survey twin (Believer-class)',
          info: 'big fuselage volume · long-endurance mapping',
          specs: { span: 1.96, rootChord: 0.24, taper: 0.65, sweepLE: 2, dihedral: 3, fusLength: 1.20, fusDiameter: 0.14, tailArm: 0.72, vh: 0.55, vv: 0.045, tailType: 'conventional', airfoil: 'sd7037', structure: 1650 } },
        { id: 'eglider2400', label: '2400 mm thermal e-glider',
          info: 'high AR · AG35 · built for minimum sink',
          specs: { span: 2.40, rootChord: 0.20, taper: 0.55, sweepLE: 0, dihedral: 4, fusLength: 1.25, fusDiameter: 0.06, tailArm: 0.85, vh: 0.50, vv: 0.030, tailType: 'ttail', airfoil: 'ag35', structure: 900 } },
        { id: 'cargo2100', label: '2100 mm heavy-lift cargo (student UAS class)',
          info: 'high-lift section · sized around the payload bay',
          specs: { span: 2.10, rootChord: 0.33, taper: 0.70, sweepLE: 0, dihedral: 3, fusLength: 1.40, fusDiameter: 0.16, tailArm: 0.85, vh: 0.60, vv: 0.045, tailType: 'conventional', airfoil: 'naca4412', structure: 2200 } },
        { id: 'survey3200', label: '3200 mm long-endurance survey (22 kg class)',
          info: 'composite · high AR · catapult or runway launch',
          specs: { span: 3.20, rootChord: 0.42, taper: 0.60, sweepLE: 2, dihedral: 2, fusLength: 2.20, fusDiameter: 0.25, tailArm: 1.35, vh: 0.55, vv: 0.040, tailType: 'ttail', airfoil: 'e205', structure: 9000 } },
        { id: 'cargo5500', label: '5500 mm heavy cargo UAV (100 kg class)',
          info: 'runway launch · sized around a 30 kg payload bay',
          specs: { span: 5.50, rootChord: 0.62, taper: 0.65, sweepLE: 0, dihedral: 2, fusLength: 3.60, fusDiameter: 0.45, tailArm: 2.20, vh: 0.60, vv: 0.050, tailType: 'conventional', airfoil: 'naca4412', structure: 42000 } }
      ]
    },
    motor: {
      label: 'Motors (motor + ESC + prop combo)',
      note: 'sets propulsion mass, max power, prop diameter, cells',
      items: [
        { id: 'm1806', label: '1806 · 2300 kV micro',    info: '5×4.5 · 2–3S · ≈45 g combo',  specs: { propMass: 45,  maxPower: 110,  propDiameter: 5,   battCells: 3 } },
        { id: 'm2204', label: '2204 · 2300 kV mini',     info: '6×4 · 3S · ≈60 g combo',      specs: { propMass: 60,  maxPower: 150,  propDiameter: 6,   battCells: 3 } },
        { id: 'm2212', label: '2212 · 1000 kV classic',  info: '10×4.7 · 3S · ≈105 g combo',  specs: { propMass: 105, maxPower: 200,  propDiameter: 10,  battCells: 3 } },
        { id: 'm2216', label: '2216 · 880 kV',           info: '11×7 · 3–4S · ≈140 g combo',  specs: { propMass: 140, maxPower: 280,  propDiameter: 11,  battCells: 4 } },
        { id: 'm2814', label: '2814 · 900 kV',           info: '12×6 · 4S · ≈180 g combo',    specs: { propMass: 180, maxPower: 450,  propDiameter: 12,  battCells: 4 } },
        { id: 'm4108', label: '4108 · 480 kV',           info: '15×8 · 6S · ≈280 g combo',    specs: { propMass: 280, maxPower: 700,  propDiameter: 15,  battCells: 6 } },
        { id: 'm5010', label: '5010 · 300 kV large',     info: '18×6.5 · 6S · ≈420 g combo',  specs: { propMass: 420, maxPower: 900,  propDiameter: 18,  battCells: 6 } },
        { id: 'm8318', label: '8318 · 120 kV heavy-lift', info: '29×9.5 · 12S · ≈1.3 kg combo', specs: { propMass: 1300, maxPower: 4000, propDiameter: 29, battCells: 12 } },
        { id: 'm15kw', label: '15 kW class UAV powertrain', info: '40 in · 14S · ≈6 kg combo',  specs: { propMass: 6000, maxPower: 15000, propDiameter: 40, battCells: 14 } }
      ]
    },
    battery: {
      label: 'Batteries',
      note: 'sets capacity, cells, energy density (from real pack mass)',
      items: [
        { id: 'b2s800',   label: '2S 800 mAh 45 C LiPo',    info: '≈45 g · 5.9 Wh',    specs: { battCapacity: 800,   battCells: 2, battDensity: 131 } },
        { id: 'b3s1300',  label: '3S 1300 mAh 45 C LiPo',   info: '≈115 g · 14.4 Wh',  specs: { battCapacity: 1300,  battCells: 3, battDensity: 125 } },
        { id: 'b3s2200',  label: '3S 2200 mAh 25 C LiPo',   info: '≈185 g · 24.4 Wh',  specs: { battCapacity: 2200,  battCells: 3, battDensity: 132 } },
        { id: 'b3s5000',  label: '3S 5000 mAh 20 C LiPo',   info: '≈400 g · 55.5 Wh',  specs: { battCapacity: 5000,  battCells: 3, battDensity: 139 } },
        { id: 'b4s3300',  label: '4S 3300 mAh 35 C LiPo',   info: '≈340 g · 48.8 Wh',  specs: { battCapacity: 3300,  battCells: 4, battDensity: 144 } },
        { id: 'b4s5200',  label: '4S 5200 mAh 15 C LiPo',   info: '≈480 g · 77.0 Wh',  specs: { battCapacity: 5200,  battCells: 4, battDensity: 160 } },
        { id: 'b6s5000',  label: '6S 5000 mAh 25 C LiPo',   info: '≈760 g · 111 Wh',   specs: { battCapacity: 5000,  battCells: 6, battDensity: 146 } },
        { id: 'bli3s35',  label: '3S 3500 mAh Li-ion (18650)', info: '≈160 g · 38.9 Wh · ≤2 C', specs: { battCapacity: 3500, battCells: 3, battDensity: 243 } },
        { id: 'bli4s7',   label: '4S2P 7000 mAh Li-ion (18650)', info: '≈420 g · 104 Wh · ≤2 C', specs: { battCapacity: 7000, battCells: 4, battDensity: 247 } },
        { id: 'b12s22',   label: '12S 22000 mAh 25 C LiPo', info: '≈6.0 kg · 977 Wh',  specs: { battCapacity: 22000, battCells: 12, battDensity: 163 } },
        { id: 'b14s30li', label: '14S3P 30000 mAh Li-ion',  info: '≈7.8 kg · 1554 Wh · ≤3 C', specs: { battCapacity: 30000, battCells: 14, battDensity: 199 } }
      ]
    }
  };

  /* ── derived-metric registry (Monte Carlo constraints/objectives) ────── */
  var METRICS = [
    { key: 'massTotal',    label: 'All-up mass',          unit: 'g',      dec: 0 },
    { key: 'battMass',     label: 'Battery mass',         unit: 'g',      dec: 0 },
    { key: 'area',         label: 'Wing area',            unit: 'dm²', dec: 1 },
    { key: 'aspectRatio',  label: 'Aspect ratio',         unit: '-',      dec: 2 },
    { key: 'mac',          label: 'Mean aero chord',      unit: 'm',      dec: 3 },
    { key: 'areaH',        label: 'H-tail area (proj.)',  unit: 'dm²', dec: 1 },
    { key: 'areaV',        label: 'Fin area (proj.)',     unit: 'dm²', dec: 1 },
    { key: 'totalLength',  label: 'Total length (nose→tail)', unit: 'm', dec: 2 },
    { key: 'wingLoading',  label: 'Wing loading',         unit: 'g/dm²', dec: 1 },
    { key: 'vstall',       label: 'Stall speed',          unit: 'm/s',    dec: 1 },
    { key: 'stallMargin',  label: 'Cruise / stall ratio', unit: '-',      dec: 2 },
    { key: 'clCruise',     label: 'CL at cruise',         unit: '-',      dec: 3 },
    { key: 'ldCruise',     label: 'L/D at cruise',        unit: '-',      dec: 1 },
    { key: 'ldMax',        label: 'L/D max',              unit: '-',      dec: 1 },
    { key: 'vLdMax',       label: 'Speed at L/D max',     unit: 'm/s',    dec: 1 },
    { key: 'cruisePowerE', label: 'Cruise power (elec)',  unit: 'W',      dec: 1 },
    { key: 'throttle',     label: 'Cruise throttle',      unit: '%',      dec: 0 },
    { key: 'current',      label: 'Cruise current',       unit: 'A',      dec: 2 },
    { key: 'cRate',        label: 'Cruise C-rate',        unit: 'C',      dec: 1 },
    { key: 'endurance',    label: 'Endurance',            unit: 'min',    dec: 0 },
    { key: 'range',        label: 'Still-air range',      unit: 'km',     dec: 1 },
    { key: 'roc',          label: 'Max rate of climb',    unit: 'm/s',    dec: 1 },
    { key: 'staticThrust', label: 'Static thrust',        unit: 'g',      dec: 0 },
    { key: 'thrustWeight', label: 'Thrust / weight',      unit: '-',      dec: 2 },
    { key: 'staticMargin', label: 'Static margin',        unit: '% MAC',  dec: 1 },
    { key: 'npMac',        label: 'Neutral point',        unit: '% MAC',  dec: 1 },
    { key: 'reCruise',     label: 'Re at cruise (MAC)',   unit: '-',      dec: 0 },
    { key: 'reTipStall',   label: 'Re at tip, stall',     unit: '-',      dec: 0 }
  ];

  var paramByKey = {};
  PARAMS.forEach(function (p) { paramByKey[p.key] = p; });
  var metricByKey = {};
  METRICS.forEach(function (m) { metricByKey[m.key] = m; });

  /* ── the model ────────────────────────────────────────────────────────
   * derive(design) — pure. All formulas documented in the page's model notes.
   */
  function airDensity(altM) {
    var t = 288.15 - 0.0065 * altM;
    return 1.225 * Math.pow(t / 288.15, 4.2561);
  }

  function derive(d) {
    var foil = AIRFOILS[d.airfoil] || AIRFOILS.clarky;
    var rho = airDensity(d.altitude);

    // planform
    var tipChord = d.rootChord * d.taper;
    var S = d.span * d.rootChord * (1 + d.taper) / 2;           // m^2
    var AR = d.span * d.span / S;
    var mac = (2 / 3) * d.rootChord * (1 + d.taper + d.taper * d.taper) / (1 + d.taper);
    var yMac = (d.span / 6) * (1 + 2 * d.taper) / (1 + d.taper);

    // tail sizing from volume coefficients (projected/effective areas)
    var flyingWing = d.tailType === 'flyingwing';
    var shEff, svEff;
    var tail = { type: d.tailType };
    if (flyingWing) {
      // no tail surfaces; yaw stability comes from sweep and tip fins.
      // winglets are carried as a fixed 8% of wing area for drag and drawing.
      shEff = 0;
      svEff = 0;
      tail.wingletArea = 0.08 * S;
    } else if (d.tailType === 'vtail') {
      shEff = d.vh * S * mac / d.tailArm;                       // m^2, horizontal projection
      svEff = d.vv * S * d.span / d.tailArm;                    // m^2, vertical projection
      // classic conversion: total V-tail area = Sh + Sv, panel dihedral from the split
      tail.gamma = Math.atan(Math.sqrt(svEff / Math.max(shEff, 1e-9)));
      tail.area = shEff + svEff;
      tail.span = Math.sqrt(d.arH * tail.area);                 // true (slant) span
      tail.rootChord = 2 * tail.area / (tail.span * (1 + d.tailTaper));
    } else {
      shEff = d.vh * S * mac / d.tailArm;
      svEff = d.vv * S * d.span / d.tailArm;
      tail.spanH = Math.sqrt(d.arH * shEff);
      tail.rootChordH = 2 * shEff / (tail.spanH * (1 + d.tailTaper));
      tail.heightV = Math.sqrt(d.arV * svEff);
      tail.rootChordV = 2 * svEff / (tail.heightV * (1 + d.tailTaper));
    }

    // overall length, nose to aft-most edge (same placement the drawings use)
    var wingRootLEx = 0.30 * d.fusLength;
    var sweepTanX = Math.tan(d.sweepLE * Math.PI / 180);
    var macLEx = wingRootLEx + yMac * sweepTanX;
    var totalLength;
    var xTailC4 = 0;
    if (flyingWing) {
      var tipTE = wingRootLEx + (d.span / 2) * sweepTanX + tipChord;
      totalLength = Math.max(d.fusLength, wingRootLEx + d.rootChord, tipTE);
    } else {
      xTailC4 = macLEx + 0.25 * mac + d.tailArm;
      var aftChord = d.tailType === 'vtail' ? tail.rootChord : Math.max(tail.rootChordH, tail.rootChordV);
      totalLength = Math.max(d.fusLength, xTailC4 + 0.75 * aftChord);
    }

    // mass budget
    var battWh = (d.battCapacity / 1000) * d.battCells * CELL_V;
    var battMassKg = battWh / d.battDensity;
    var massKg = (d.structure + d.payload + d.avionics + d.propMass) / 1000 + battMassKg;
    var weightN = massKg * G;

    // lift limits (finite-wing knockdown on the 2-D section); a flying wing
    // loses a further ~15% of CL max to the washout/reflex needed for trim
    var clMax3D = 0.9 * foil.clmax * (flyingWing ? 0.85 : 1);
    var claw = foil.cla / (1 + foil.cla / (Math.PI * d.oswald * AR)); // per rad, 3-D
    var vstall = Math.sqrt(2 * weightN / (rho * S * clMax3D));

    // parasite drag buildup (referenced to wing area), +15% interference/misc
    var fusWetted = Math.PI * d.fusDiameter * d.fusLength * 0.8;
    var cd0Fus = 0.006 * fusWetted / S;
    var cd0Tail = flyingWing ? 0.008 * tail.wingletArea / S : 0.008 * (shEff + svEff) / S;
    var cd0 = 1.15 * (foil.cd0 + cd0Fus + cd0Tail);
    var k = 1 / (Math.PI * d.oswald * AR);

    // cruise point
    var v = d.cruiseSpeed;
    var q = 0.5 * rho * v * v;
    var clCruise = weightN / (q * S);
    var cdCruise = cd0 + k * clCruise * clCruise;
    var dragN = q * S * cdCruise;
    var pMechCruise = dragN * v;
    var pElecCruise = pMechCruise / (d.etaProp * d.etaMotor);
    var packV = d.battCells * CELL_V;
    var current = pElecCruise / packV;
    var cRate = current / (d.battCapacity / 1000);
    var enduranceH = (d.battCapacity / 1000) * d.usableBatt / current;
    var rangeKm = v * 3.6 * enduranceH;

    // best-glide numbers
    var clStar = Math.sqrt(cd0 / k);
    var ldMax = 1 / (2 * Math.sqrt(k * cd0));
    var vLdMax = Math.sqrt(2 * weightN / (rho * S * clStar));

    // climb: excess power at the minimum-power speed (CL = sqrt(3*CD0/k))
    var clMinP = Math.sqrt(3 * cd0 / k);
    var clMinPCl = Math.min(clMinP, clMax3D);
    var vMinP = Math.sqrt(2 * weightN / (rho * S * clMinPCl));
    var cdMinP = cd0 + k * clMinPCl * clMinPCl;
    var pReqMinMech = 0.5 * rho * vMinP * vMinP * vMinP * S * cdMinP;
    var pAvailMech = d.maxPower * d.etaMotor * d.etaProp;
    var roc = Math.max(0, (pAvailMech - pReqMinMech) / weightN);

    // static thrust: actuator disk with a 0.7 static figure of merit
    var diskA = Math.PI * Math.pow(d.propDiameter * 0.0254, 2) / 4;
    var pShaft = d.maxPower * d.etaMotor;
    var staticThrustN = 0.7 * Math.pow(2 * rho * diskA, 1 / 3) * Math.pow(pShaft, 2 / 3);
    var tw = staticThrustN / weightN;

    // longitudinal stability. Tailed: tail-volume neutral point with downwash,
    // 0.9 tail efficiency, and a -4% MAC fuselage (Munk) correction; the tail
    // lift-curve slope comes from the configured tail AR, and a T-tail sits
    // above the wake with ~30% less downwash gradient. Flying wing: the NP is
    // the wing aerodynamic center (25% MAC — sweep already shifts the MAC
    // position) with a small -2% blended-body correction; CG must sit ahead
    // of it, and the section pitching moment must be near zero to trim.
    var npFrac, deda = 0, clat = 0;
    if (flyingWing) {
      npFrac = 0.25 - 0.02;
    } else {
      clat = 5.8 / (1 + 5.8 / (Math.PI * 0.9 * d.arH));
      var dedaFactor = d.tailType === 'ttail' ? 0.7 : 1.0;
      deda = Math.min(0.9, dedaFactor * 2 * claw / (Math.PI * AR));
      npFrac = 0.25 + 0.9 * d.vh * (clat / claw) * (1 - deda) - 0.04;
    }
    var smFrac = npFrac - d.cgMac / 100;

    return {
      foil: foil, rho: rho, tail: tail,
      tipChord: tipChord, S: S, shEff: shEff, svEff: svEff, yMac: yMac,
      weightN: weightN, battWh: battWh,
      cd0: cd0, k: k, claw: claw, clat: clat, deda: deda, clMax3D: clMax3D,
      pAvailMech: pAvailMech, packV: packV,
      // registry metrics
      massTotal: massKg * 1000,
      battMass: battMassKg * 1000,
      area: S * 100,
      aspectRatio: AR,
      mac: mac,
      areaH: shEff * 100,
      areaV: svEff * 100,
      totalLength: totalLength,
      wingLoading: massKg * 1000 / (S * 100),
      vstall: vstall,
      stallMargin: v / vstall,
      clCruise: clCruise,
      ldCruise: clCruise / cdCruise,
      ldMax: ldMax,
      vLdMax: vLdMax,
      cruisePowerE: pElecCruise,
      throttle: 100 * pElecCruise / d.maxPower,
      current: current,
      cRate: cRate,
      endurance: enduranceH * 60,
      range: rangeKm,
      roc: roc,
      staticThrust: staticThrustN / G * 1000,
      thrustWeight: tw,
      staticMargin: smFrac * 100,
      npMac: npFrac * 100,
      reCruise: rho * v * mac / MU_AIR,
      reTipStall: rho * vstall * tipChord / MU_AIR
    };
  }

  // electrical power required at speed v (for the power chart + hover)
  function powerElecAt(d, r, v) {
    var q = 0.5 * r.rho * v * v;
    var cl = r.weightN / (q * r.S);
    if (cl > r.clMax3D) return NaN; // below stall
    var cd = r.cd0 + r.k * cl * cl;
    return q * r.S * cd * v / (d.etaProp * d.etaMotor);
  }

  /* ── design checks ────────────────────────────────────────────────────── */
  function designChecks(d, r) {
    function band(v, okLo, okHi, warnLo, warnHi) {
      if (v >= okLo && v <= okHi) return 'ok';
      if (v >= warnLo && v <= warnHi) return 'warn';
      return 'fail';
    }
    var flyingWing = d.tailType === 'flyingwing';
    var checksList = [
      flyingWing
        ? { label: 'Static margin', value: fmt(r.staticMargin, 1) + ' % MAC', limit: '3–8 % for flying wings (pitch damping is scarce)',
            status: band(r.staticMargin, 3, 8, 1, 12) }
        : { label: 'Static margin', value: fmt(r.staticMargin, 1) + ' % MAC', limit: '5–15 % stable, docile',
            status: band(r.staticMargin, 5, 15, 2, 25) },
      { label: 'Thrust / weight', value: fmt(r.thrustWeight, 2), limit: '≥ 0.60 sport; ≥ 0.35 gentle',
        status: r.thrustWeight >= 0.6 ? 'ok' : r.thrustWeight >= 0.35 ? 'warn' : 'fail' },
      { label: 'Cruise / stall speed', value: fmt(r.stallMargin, 2), limit: '≥ 1.4 comfortable margin',
        status: r.stallMargin >= 1.4 ? 'ok' : r.stallMargin >= 1.2 ? 'warn' : 'fail' },
      { label: 'CL cruise vs CL max', value: fmt(r.clCruise, 2) + ' / ' + fmt(r.clMax3D, 2), limit: '≤ 70 % of CL max',
        status: r.clCruise <= 0.7 * r.clMax3D ? 'ok' : r.clCruise <= 0.9 * r.clMax3D ? 'warn' : 'fail' },
      { label: 'Cruise throttle', value: fmt(r.throttle, 0) + ' %', limit: '≤ 60 % leaves climb reserve',
        status: r.throttle <= 60 ? 'ok' : r.throttle <= 85 ? 'warn' : 'fail' },
      { label: 'Cruise C-rate', value: fmt(r.cRate, 1) + ' C', limit: '≤ 20 C sustained draw',
        status: r.cRate <= 20 ? 'ok' : r.cRate <= 35 ? 'warn' : 'fail' },
      { label: 'Tip Reynolds at stall', value: fmtInt(r.reTipStall), limit: '≥ 100k avoids tip-stall regime',
        status: r.reTipStall >= 100000 ? 'ok' : r.reTipStall >= 50000 ? 'warn' : 'fail' }
    ];
    if (flyingWing) {
      // with no tail, the wing section's own pitching moment must be trimmable
      // by reflex/washout — strongly cambered sections cannot be
      checksList.push({ label: 'Section cm vs configuration', value: fmt(r.foil.cm, 3),
        limit: '≥ −0.02 for a flying wing (reflexed section)',
        status: r.foil.cm >= -0.02 ? 'ok' : r.foil.cm >= -0.06 ? 'warn' : 'fail' });
      checksList.push({ label: 'Sweep for a flying wing', value: fmt(d.sweepLE, 1) + '°',
        limit: '15–35° gives washout leverage and pitch authority',
        status: band(d.sweepLE, 15, 35, 8, 40) });
    }
    return checksList;
  }

  /* ── formatting ──────────────────────────────────────────────────────── */
  function fmt(v, dec) {
    if (!isFinite(v) || isNaN(v)) return DASH;
    return v.toFixed(dec);
  }
  function fmtInt(v) {
    if (!isFinite(v) || isNaN(v)) return DASH;
    v = Math.round(v);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  function fmtMetric(key, v) {
    var m = metricByKey[key];
    if (m) return (m.dec === 0 ? fmtInt(v) : fmt(v, m.dec));
    var p = paramByKey[key];
    if (p) return fmt(v, decimalsOf(p.step));
    return fmt(v, 2);
  }
  function decimalsOf(step) {
    var s = String(step);
    var i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── state ───────────────────────────────────────────────────────────── */
  var design = defaultDesign();
  var derived = null;
  var mcResult = null;
  var activePreset = { airframe: null, motor: null, battery: null };

  function defaultDesign() {
    var d = {};
    PARAMS.forEach(function (p) { d[p.key] = p.def; });
    return d;
  }

  /* ── parameter form (generated from PARAMS) ──────────────────────────── */
  function buildForm() {
    var host = document.getElementById('uav-form');
    var html = '';
    GROUPS.forEach(function (g) {
      html += '<div class="uav-group-label">' + esc(g.label) + '</div>';
      html += '<div class="tools-form">';
      PARAMS.filter(function (p) { return p.group === g.id; }).forEach(function (p) {
        html += '<label><span>' + esc(p.label) + ' (' + esc(p.unit) + ')</span>';
        if (p.options) {
          html += '<select data-param="' + p.key + '">';
          Object.keys(p.options).forEach(function (k) {
            html += '<option value="' + k + '">' + esc(p.options[k].label) + '</option>';
          });
          html += '</select>';
        } else {
          html += '<input type="number" data-param="' + p.key + '" min="' + p.min + '" max="' + p.max +
                  '" step="' + p.step + '" autocomplete="off" inputmode="decimal">';
        }
        html += '</label>';
      });
      html += '</div>';
    });
    host.innerHTML = html;
    host.addEventListener('input', function (e) {
      var key = e.target.getAttribute('data-param');
      if (!key) return;
      var p = paramByKey[key];
      if (p.options) {
        design[key] = e.target.value;
      } else {
        var v = parseFloat(e.target.value);
        if (!isFinite(v)) return; // keep last valid value while the user types
        design[key] = Math.min(p.max, Math.max(p.min, v));
      }
      designTouched = true;
      notePresetDivergence(key);
      recompute();
    });
  }

  function syncForm() {
    PARAMS.forEach(function (p) {
      var el = document.querySelector('[data-param="' + p.key + '"]');
      if (!el) return;
      if (p.options) el.value = design[p.key];
      else el.value = String(+design[p.key].toFixed(6));
    });
  }

  // gray out and exclude inputs the current configuration ignores
  function updateRelevance() {
    PARAMS.forEach(function (p) {
      var rel = paramRelevant(p.key, design);
      var el = document.querySelector('[data-param="' + p.key + '"]');
      if (el) {
        el.disabled = !rel;
        el.closest('label').classList.toggle('uav-param-irrelevant', !rel);
      }
      var cb = document.querySelector('[data-mc-vary="' + p.key + '"]');
      if (cb) {
        if (!rel && !cb.disabled) {
          cb.dataset.wasChecked = cb.checked ? '1' : '';
          cb.checked = false;
          cb.disabled = true;
        } else if (rel && cb.disabled) {
          cb.disabled = false;
          if (cb.dataset.wasChecked) cb.checked = true;
        }
      }
    });
  }

  /* ── COTS preset tables ──────────────────────────────────────────────── */
  function buildPresetTables() {
    var host = document.getElementById('uav-presets');
    var html = '';
    Object.keys(PRESETS).forEach(function (cat) {
      var c = PRESETS[cat];
      html += '<div class="uav-group-label">' + esc(c.label) + ' <span class="uav-preset-note">&mdash; ' + esc(c.note) + '</span></div>';
      html += '<div class="table-scroll"><table class="tools-ref-table uav-preset-table"><tbody>';
      c.items.forEach(function (it) {
        html += '<tr id="preset-' + cat + '-' + it.id + '">' +
          '<td class="uav-preset-name">' + esc(it.label) + '</td>' +
          '<td class="desc">' + esc(it.info) + '</td>' +
          '<td class="tool-cta"><a href="#" data-preset="' + cat + ':' + it.id + '">Apply &rarr;</a></td></tr>';
      });
      html += '</tbody></table></div>';
    });
    host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var a = e.target.closest('[data-preset]');
      if (!a) return;
      e.preventDefault();
      var parts = a.getAttribute('data-preset').split(':');
      applyPreset(parts[0], parts[1]);
    });
  }

  function applyPreset(cat, id) {
    var item = null;
    PRESETS[cat].items.forEach(function (it) { if (it.id === id) item = it; });
    if (!item) return;
    var setKeys = [], changedKeys = [];
    Object.keys(item.specs).forEach(function (key) {
      var p = paramByKey[key];
      if (!p) return;
      var v = p.options ? item.specs[key] : Math.min(p.max, Math.max(p.min, item.specs[key]));
      if (design[key] !== v) changedKeys.push(key);
      design[key] = v;
      setKeys.push(p.label);
    });
    activePreset[cat] = id;
    designTouched = true;
    // a spec that actually changes another category's keys invalidates that selection
    Object.keys(PRESETS).forEach(function (other) {
      if (other === cat) return;
      if (activePreset[other] && changedKeys.some(function (k) { return presetOwns(other, k); })) {
        activePreset[other] = null;
      }
    });
    syncForm();
    recompute();
    renderPresetStatus();
    document.getElementById('uav-preset-status').textContent =
      'Applied ' + item.label + ' — set: ' + setKeys.join(', ') + '. All values remain editable.';
  }

  function presetOwns(cat, key) {
    return PRESETS[cat].items.some(function (it) { return key in it.specs; });
  }

  function notePresetDivergence(key) {
    var changed = false;
    Object.keys(PRESETS).forEach(function (cat) {
      if (activePreset[cat] && presetOwns(cat, key)) { activePreset[cat] = null; changed = true; }
    });
    if (changed) renderPresetStatus();
  }

  function renderPresetStatus() {
    Object.keys(PRESETS).forEach(function (cat) {
      PRESETS[cat].items.forEach(function (it) {
        var row = document.getElementById('preset-' + cat + '-' + it.id);
        if (row) row.classList.toggle('uav-preset-active', activePreset[cat] === it.id);
      });
    });
  }

  /* ── readouts ────────────────────────────────────────────────────────── */
  var READOUTS = [
    { key: 'massTotal',    sub: function (r) { return 'battery ' + fmtInt(r.battMass) + ' g · ' + fmt(r.battWh, 1) + ' Wh'; } },
    { key: 'wingLoading',  sub: function (r) { return fmt(r.massTotal / 1000 / r.S, 2) + ' kg/m²'; } },
    { key: 'area',         sub: function (r) { return 'AR ' + fmt(r.aspectRatio, 2) + ' · MAC ' + fmt(r.mac * 1000, 0) + ' mm'; } },
    { key: 'areaH',        sub: function (r) {
        if (r.tail.type === 'flyingwing') return 'no tail — flying wing; trim by reflex + sweep';
        return r.tail.type === 'vtail'
          ? 'V-tail Γ ' + fmt(r.tail.gamma * 180 / Math.PI, 0) + '° · true area ' + fmt(r.tail.area * 100, 1) + ' dm²'
          : 'span ' + fmt(r.tail.spanH, 2) + ' m · root ' + fmt(r.tail.rootChordH * 1000, 0) + ' mm'; } },
    { key: 'areaV',        sub: function (r) {
        if (r.tail.type === 'flyingwing') return 'winglets ' + fmt(r.tail.wingletArea * 100, 1) + ' dm² total (fixed 8% of S)';
        return r.tail.type === 'vtail'
          ? 'projected from the V panels'
          : 'height ' + fmt(r.tail.heightV, 2) + ' m · root ' + fmt(r.tail.rootChordV * 1000, 0) + ' mm'; } },
    { key: 'totalLength',  sub: function (r) { return 'fuselage ' + fmt(design.fusLength, 2) + ' m · overhang ' + fmt(Math.max(0, r.totalLength - design.fusLength), 2) + ' m'; } },
    { key: 'vstall',       sub: function (r) { return fmt(r.vstall * 3.6, 1) + ' km/h at CL ' + fmt(r.clMax3D, 2); } },
    { key: 'ldCruise',     sub: function (r) { return 'L/D max ' + fmt(r.ldMax, 1) + ' at ' + fmt(r.vLdMax, 1) + ' m/s'; } },
    { key: 'cruisePowerE', sub: function (r) { return fmt(r.throttle, 0) + ' % throttle · ' + fmt(r.current, 1) + ' A · ' + fmt(r.cRate, 1) + ' C'; } },
    { key: 'endurance',    sub: function (r) { return 'range ' + fmt(r.range, 1) + ' km still air'; } },
    { key: 'roc',          sub: function (r) { return 'excess power at Vₘᴘ · full throttle'; } },
    { key: 'thrustWeight', sub: function (r) { return 'static thrust ' + fmtInt(r.staticThrust) + ' g'; } },
    { key: 'staticMargin', sub: function (r) { return 'NP at ' + fmt(r.npMac, 1) + ' % MAC'; } },
    { key: 'stallMargin',  sub: function (r) { return 'cruise ' + fmt(design.cruiseSpeed, 1) + ' / stall ' + fmt(r.vstall, 1) + ' m/s'; } },
    { key: 'reCruise',     sub: function (r) { return 'tip at stall ' + fmtInt(r.reTipStall); } }
  ];

  function renderReadouts(r) {
    var html = '';
    READOUTS.forEach(function (ro) {
      var m = metricByKey[ro.key];
      html += '<div class="tools-readout">' +
        '<span class="tools-readout-label">' + esc(m.label) + '</span>' +
        '<span class="tools-readout-value mono">' + fmtMetric(ro.key, r[ro.key]) +
        (m.unit !== '-' ? '<span class="uav-unit"> ' + esc(m.unit) + '</span>' : '') + '</span>' +
        '<span class="tools-readout-sub">' + ro.sub(r) + '</span></div>';
    });
    document.getElementById('uav-readouts').innerHTML = html;
  }

  function checksRowsHtml(d, r) {
    var rows = designChecks(d, r);
    var html = '';
    var words = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
    rows.forEach(function (c) {
      html += '<tr><td>' + esc(c.label) + '</td><td class="num">' + c.value + '</td>' +
        '<td class="desc">' + c.limit + '</td>' +
        '<td class="uav-status uav-status-' + c.status + '">' + words[c.status] + '</td></tr>';
    });
    return html;
  }

  function renderChecks(d, r) {
    document.getElementById('uav-checks-body').innerHTML = checksRowsHtml(d, r);
  }

  /* ── SVG helpers ─────────────────────────────────────────────────────── */
  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img">';
  }
  function line(x1, y1, x2, y2, cls) {
    return '<line x1="' + f2(x1) + '" y1="' + f2(y1) + '" x2="' + f2(x2) + '" y2="' + f2(y2) + '" class="' + cls + '"/>';
  }
  function poly(pts, cls) {
    return '<polygon points="' + pts.map(function (p) { return f2(p[0]) + ',' + f2(p[1]); }).join(' ') + '" class="' + cls + '"/>';
  }
  function path(dstr, cls) {
    return '<path d="' + dstr + '" class="' + cls + '"/>';
  }
  function text(x, y, s, cls, anchor) {
    return '<text x="' + f2(x) + '" y="' + f2(y) + '" class="' + cls + '"' +
      (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(s) + '</text>';
  }
  function f2(v) { return (Math.round(v * 100) / 100).toString(); }

  function dimH(x1, x2, y, label) {
    return line(x1, y, x2, y, 'uav-dim') +
      line(x1, y - 4, x1, y + 4, 'uav-dim') + line(x2, y - 4, x2, y + 4, 'uav-dim') +
      text((x1 + x2) / 2, y - 5, label, 'uav-dim-label', 'middle');
  }

  function cgSymbol(x, y, r) {
    // quartered circle — standard CG mark
    var s = '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + r + '" class="uav-cg-ring"/>';
    s += path('M ' + f2(x) + ' ' + f2(y) + ' L ' + f2(x + r) + ' ' + f2(y) + ' A ' + r + ' ' + r + ' 0 0 1 ' + f2(x) + ' ' + f2(y + r) + ' Z', 'uav-cg-fill');
    s += path('M ' + f2(x) + ' ' + f2(y) + ' L ' + f2(x - r) + ' ' + f2(y) + ' A ' + r + ' ' + r + ' 0 0 1 ' + f2(x) + ' ' + f2(y - r) + ' Z', 'uav-cg-fill');
    return s;
  }

  /* ── airframe geometry for drawing (x = 0 at the nose, meters) ───────── */
  function layout(d, r) {
    var wingRootLE = 0.30 * d.fusLength;
    var sweepTan = Math.tan(d.sweepLE * Math.PI / 180);
    var macLE = wingRootLE + r.yMac * sweepTan;
    var xC4Mac = macLE + 0.25 * r.mac;
    var xTailC4 = xC4Mac + d.tailArm;
    var t = r.tail;
    // drawing spans/chords per tail type
    var bhDraw, chRoot, chTip, hv, cvRoot, cvTip, gamma = 0;
    if (t.type === 'flyingwing') {
      bhDraw = 0; chRoot = 0; chTip = 0;
      // each winglet: half the fixed winglet area at roughly tip-chord length
      cvRoot = Math.max(0.6 * r.tipChord, 0.02);
      hv = Math.min(0.5 * r.tipChord + (t.wingletArea / 2) / cvRoot, 0.25 * d.span);
      cvTip = 0.6 * cvRoot;
    } else if (t.type === 'vtail') {
      gamma = t.gamma;
      bhDraw = t.span * Math.cos(gamma);                 // projected span, top view
      chRoot = t.rootChord; chTip = t.rootChord * d.tailTaper;
      hv = (t.span / 2) * Math.sin(gamma);               // projected height, side view
      cvRoot = t.rootChord; cvTip = chTip;
    } else {
      bhDraw = t.spanH;
      chRoot = t.rootChordH; chTip = t.rootChordH * d.tailTaper;
      hv = t.heightV;
      cvRoot = t.rootChordV; cvTip = t.rootChordV * d.tailTaper;
    }
    return {
      wingRootLE: wingRootLE, sweepTan: sweepTan, macLE: macLE,
      xC4Mac: xC4Mac, xTailC4: xTailC4,
      bhDraw: bhDraw, chRoot: chRoot, chTip: chTip,
      hv: hv, cvRoot: cvRoot, cvTip: cvTip, gamma: gamma,
      xCG: macLE + (d.cgMac / 100) * r.mac,
      xNP: macLE + (r.npMac / 100) * r.mac,
      totalLength: r.totalLength // same placement math as the derived metric
    };
  }

  /* ── top view ────────────────────────────────────────────────────────── */
  function renderTopView(d, r, targetId) {
    var L = layout(d, r);
    var W = 640, H = 420, pad = 48;
    var scale = Math.min((W - 2 * pad) / d.span, (H - 2 * pad - 20) / L.totalLength);
    var cx = W / 2;
    var y0 = pad + 10; // nose y
    function X(spanwise) { return cx + spanwise * scale; }
    function Y(x) { return y0 + x * scale; }

    var s = svgOpen(W, H);
    s += '<title>Top view of the configured airframe, to scale</title>';
    // centerline
    s += line(cx, y0 - 8, cx, Y(L.totalLength) + 8, 'uav-centerline');
    // fuselage (simple pod: rounded nose, straight taper aft)
    var fr = d.fusDiameter / 2 * scale;
    s += path('M ' + f2(cx - fr) + ' ' + f2(Y(0.06 * d.fusLength)) +
      ' Q ' + f2(cx - fr) + ' ' + f2(Y(0)) + ' ' + f2(cx) + ' ' + f2(Y(0)) +
      ' Q ' + f2(cx + fr) + ' ' + f2(Y(0)) + ' ' + f2(cx + fr) + ' ' + f2(Y(0.06 * d.fusLength)) +
      ' L ' + f2(cx + fr) + ' ' + f2(Y(0.7 * d.fusLength)) +
      ' L ' + f2(cx + 0.35 * fr) + ' ' + f2(Y(d.fusLength)) +
      ' L ' + f2(cx - 0.35 * fr) + ' ' + f2(Y(d.fusLength)) +
      ' L ' + f2(cx - fr) + ' ' + f2(Y(0.7 * d.fusLength)) + ' Z', 'uav-skin');
    // tail boom if the tail sits behind the fuselage
    var boomEnd = L.xTailC4 + 0.75 * L.chRoot;
    if (r.tail.type !== 'flyingwing' && boomEnd > d.fusLength) {
      s += line(cx, Y(d.fusLength), cx, Y(boomEnd), 'uav-boom');
    }
    // wing planform
    var half = d.span / 2;
    var rootLE = L.wingRootLE, tipLE = rootLE + half * L.sweepTan;
    s += poly([
      [X(0), Y(rootLE)], [X(half), Y(tipLE)], [X(half), Y(tipLE + r.tipChord)],
      [X(0), Y(rootLE + d.rootChord)], [X(-half), Y(tipLE + r.tipChord)], [X(-half), Y(tipLE)]
    ], 'uav-surface');
    // MAC chord line
    s += line(X(r.yMac), Y(L.macLE), X(r.yMac), Y(L.macLE + r.mac), 'uav-macline');
    s += text(X(r.yMac) + 5, Y(L.macLE + r.mac / 2), 'MAC', 'uav-fig-label');
    if (r.tail.type === 'flyingwing') {
      // winglets: chordwise strips at the tips
      s += line(X(half), Y(tipLE), X(half), Y(tipLE + r.tipChord), 'uav-boom');
      s += line(X(-half), Y(tipLE), X(-half), Y(tipLE + r.tipChord), 'uav-boom');
      s += text(X(half) - 6, Y(tipLE) - 6, 'winglet', 'uav-fig-label', 'end');
      if (d.sweepLE > 0) s += text(X(0) + 8, Y(rootLE) - 6, 'sweep ' + fmt(d.sweepLE, 0) + '°', 'uav-fig-label');
    } else {
      // tail planform (projected for a V-tail)
      var thLE = L.xTailC4 - 0.25 * L.chRoot;
      var htHalf = L.bhDraw / 2;
      s += poly([
        [X(0), Y(thLE)], [X(htHalf), Y(thLE + (L.chRoot - L.chTip) / 2)],
        [X(htHalf), Y(thLE + (L.chRoot + L.chTip) / 2)], [X(0), Y(thLE + L.chRoot)],
        [X(-htHalf), Y(thLE + (L.chRoot + L.chTip) / 2)], [X(-htHalf), Y(thLE + (L.chRoot - L.chTip) / 2)]
      ], 'uav-surface');
      if (r.tail.type === 'vtail') {
        s += text(X(htHalf) + 4, Y(thLE + L.chRoot / 2), 'V-tail Γ ' + fmt(L.gamma * 180 / Math.PI, 0) + '°', 'uav-fig-label');
      }
    }
    // CG / NP on centerline
    s += cgSymbol(cx, Y(L.xCG), 6);
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(Y(L.xNP)) + '" r="3.5" class="uav-np"/>';
    s += text(cx + 10, Y(L.xCG) + 3, 'CG', 'uav-fig-label');
    s += text(cx + 10, Y(L.xNP) + 3, 'NP', 'uav-fig-label uav-fig-label-accent');
    // dimensions
    s += dimH(X(-half), X(half), y0 - 2, 'span ' + fmt(d.span, 2) + ' m');
    // vertical dim: fuselage length
    var dx = X(half) + 26;
    s += line(dx, Y(0), dx, Y(d.fusLength), 'uav-dim');
    s += line(dx - 4, Y(0), dx + 4, Y(0), 'uav-dim');
    s += line(dx - 4, Y(d.fusLength), dx + 4, Y(d.fusLength), 'uav-dim');
    s += '<text x="' + f2(dx + 4) + '" y="' + f2(Y(d.fusLength / 2)) + '" class="uav-dim-label" transform="rotate(90 ' + f2(dx + 4) + ' ' + f2(Y(d.fusLength / 2)) + ')" text-anchor="middle">fus ' + fmt(d.fusLength, 2) + ' m</text>';
    s += '</svg>';
    document.getElementById(targetId || 'uav-top-view').innerHTML = s;
  }

  /* ── side view ───────────────────────────────────────────────────────── */
  function renderSideView(d, r, targetId) {
    var L = layout(d, r);
    var W = 640, H = 220, pad = 40;
    var finTop = d.fusDiameter + L.hv;
    var scale = Math.min((W - 2 * pad) / L.totalLength, (H - 2 * pad) / (finTop + d.fusDiameter));
    var x0 = pad, yRef = H - pad - d.fusDiameter * 0.5 * scale; // fuselage centerline y
    function X(x) { return x0 + x * scale; }

    var fr = d.fusDiameter / 2 * scale;
    var s = svgOpen(W, H);
    s += '<title>Side view with CG and neutral point positions</title>';
    // fuselage profile
    s += path('M ' + f2(X(0.06 * d.fusLength)) + ' ' + f2(yRef - fr) +
      ' Q ' + f2(X(0)) + ' ' + f2(yRef - fr) + ' ' + f2(X(0)) + ' ' + f2(yRef) +
      ' Q ' + f2(X(0)) + ' ' + f2(yRef + fr) + ' ' + f2(X(0.06 * d.fusLength)) + ' ' + f2(yRef + fr) +
      ' L ' + f2(X(0.65 * d.fusLength)) + ' ' + f2(yRef + fr) +
      ' L ' + f2(X(d.fusLength)) + ' ' + f2(yRef + 0.2 * fr) +
      ' L ' + f2(X(d.fusLength)) + ' ' + f2(yRef - 0.2 * fr) +
      ' L ' + f2(X(0.65 * d.fusLength)) + ' ' + f2(yRef - fr) + ' Z', 'uav-skin');
    var boomEnd = L.xTailC4 + 0.75 * L.chRoot;
    if (r.tail.type !== 'flyingwing' && boomEnd > d.fusLength) s += line(X(d.fusLength), yRef, X(boomEnd), yRef, 'uav-boom');
    // wing root chord silhouette on top of fuselage
    var wingY = yRef - fr;
    s += poly([
      [X(L.wingRootLE), wingY], [X(L.wingRootLE + d.rootChord), wingY],
      [X(L.wingRootLE + d.rootChord), wingY - Math.max(3, 0.12 * d.rootChord * scale)],
      [X(L.wingRootLE + 0.3 * d.rootChord), wingY - Math.max(4, 0.16 * d.rootChord * scale)],
      [X(L.wingRootLE), wingY - Math.max(2, 0.06 * d.rootChord * scale)]
    ], 'uav-surface');
    // tail surfaces by configuration
    var finBaseLE = L.xTailC4 - 0.25 * L.cvRoot;
    var finTopY = yRef - 0.2 * fr - L.hv * scale;
    if (r.tail.type === 'flyingwing') {
      // winglet silhouette at the swept tip position
      var wlLE = L.wingRootLE + (d.span / 2) * L.sweepTan;
      s += poly([
        [X(wlLE), wingY],
        [X(wlLE + 0.45 * L.cvRoot), wingY - L.hv * scale],
        [X(wlLE + 0.45 * L.cvRoot + L.cvTip), wingY - L.hv * scale],
        [X(wlLE + L.cvRoot), wingY]
      ], 'uav-surface');
      s += text(X(wlLE) - 4, wingY - L.hv * scale - 5, 'winglet', 'uav-fig-label');
    } else if (r.tail.type === 'vtail') {
      // single inclined panel drawn at its projected height
      s += poly([
        [X(finBaseLE), yRef - 0.2 * fr],
        [X(finBaseLE + 0.45 * L.cvRoot), finTopY],
        [X(finBaseLE + 0.45 * L.cvRoot + L.cvTip), finTopY],
        [X(finBaseLE + L.cvRoot), yRef - 0.2 * fr]
      ], 'uav-surface');
      s += text(X(finBaseLE) - 4, finTopY - 5, 'V-tail Γ ' + fmt(L.gamma * 180 / Math.PI, 0) + '°', 'uav-fig-label');
    } else {
      // fin
      s += poly([
        [X(finBaseLE - 0.35 * L.cvRoot), yRef - 0.2 * fr],
        [X(finBaseLE + 0.45 * L.cvRoot), finTopY],
        [X(finBaseLE + 0.45 * L.cvRoot + L.cvTip), finTopY],
        [X(finBaseLE + 1.05 * L.cvRoot), yRef - 0.2 * fr]
      ], 'uav-surface');
      // tailplane chord line: at the fin top for a T-tail, on the fuselage otherwise
      var tpY = r.tail.type === 'ttail' ? finTopY : yRef - 0.15 * fr;
      s += line(X(L.xTailC4 - 0.25 * L.chRoot), tpY, X(L.xTailC4 + 0.75 * L.chRoot), tpY, 'uav-hstab');
      if (r.tail.type === 'ttail') s += text(X(L.xTailC4 + 0.75 * L.chRoot) + 3, tpY + 3, 'T', 'uav-fig-label');
    }
    // CG + NP
    s += cgSymbol(X(L.xCG), yRef, 6);
    s += '<circle cx="' + f2(X(L.xNP)) + '" cy="' + f2(yRef) + '" r="3.5" class="uav-np"/>';
    s += text(X(L.xCG) - 4, yRef + 20, 'CG ' + fmt(d.cgMac, 0) + '%', 'uav-fig-label');
    s += text(X(L.xNP) - 4, yRef - 14, 'NP ' + fmt(r.npMac, 0) + '%', 'uav-fig-label uav-fig-label-accent');
    // tail arm dimension (meaningless for a flying wing)
    if (r.tail.type !== 'flyingwing') {
      s += dimH(X(L.xC4Mac), X(L.xTailC4), H - 14, 'tail arm ' + fmt(d.tailArm, 2) + ' m');
    }
    s += '</svg>';
    document.getElementById(targetId || 'uav-side-view').innerHTML = s;
  }

  /* ── front view ──────────────────────────────────────────────────────── */
  function renderFrontView(d, r) {
    var L = layout(d, r);
    var W = 640, H = 200, pad = 40;
    var half = d.span / 2;
    var tipRise = half * Math.tan(d.dihedral * Math.PI / 180);
    var propR = d.propDiameter * 0.0254 / 2;
    var scale = Math.min((W - 2 * pad) / d.span, (H - 2 * pad) / Math.max(tipRise + d.fusDiameter + L.hv, 2 * propR, 0.2));
    var cx = W / 2, cy = H - pad - Math.max(propR * scale - 10, 0);
    var fr = d.fusDiameter / 2 * scale;

    var s = svgOpen(W, H);
    s += '<title>Front view: dihedral, fuselage section, tail, prop disk</title>';
    // prop disk
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(cy) + '" r="' + f2(propR * scale) + '" class="uav-propdisk"/>';
    // wing panels (thin quadrilaterals along dihedral)
    var t = Math.max(2, 0.04 * d.rootChord * scale);
    s += poly([[cx, cy - fr], [cx + half * scale, cy - fr - tipRise * scale], [cx + half * scale, cy - fr - tipRise * scale - t], [cx, cy - fr - t]], 'uav-surface');
    s += poly([[cx, cy - fr], [cx - half * scale, cy - fr - tipRise * scale], [cx - half * scale, cy - fr - tipRise * scale - t], [cx, cy - fr - t]], 'uav-surface');
    // fuselage section
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(cy) + '" r="' + f2(fr) + '" class="uav-skin"/>';
    // tail by configuration
    if (r.tail.type === 'flyingwing') {
      var tipY = cy - fr - tipRise * scale;
      s += line(cx + half * scale, tipY, cx + half * scale, tipY - L.hv * scale, 'uav-boom');
      s += line(cx - half * scale, tipY, cx - half * scale, tipY - L.hv * scale, 'uav-boom');
      s += text(cx + half * scale - 4, tipY - L.hv * scale - 4, 'winglets', 'uav-fig-label', 'end');
    } else if (r.tail.type === 'vtail') {
      var vx = (L.bhDraw / 2) * scale, vy = L.hv * scale; // panel projections
      s += line(cx, cy - fr, cx + vx, cy - fr - vy, 'uav-boom');
      s += line(cx, cy - fr, cx - vx, cy - fr - vy, 'uav-boom');
      s += text(cx + vx + 4, cy - fr - vy + 4, 'V-tail', 'uav-fig-label');
    } else {
      var finH = L.hv * scale;
      s += line(cx, cy - fr, cx, cy - fr - finH, 'uav-boom');
      if (r.tail.type === 'ttail') {
        var htHalf = (L.bhDraw / 2) * scale;
        s += line(cx - htHalf, cy - fr - finH, cx + htHalf, cy - fr - finH, 'uav-hstab');
        s += text(cx + htHalf + 4, cy - fr - finH + 4, 'T-tail', 'uav-fig-label');
      } else {
        var htHalf2 = (L.bhDraw / 2) * scale;
        s += line(cx - htHalf2, cy - fr * 0.4, cx + htHalf2, cy - fr * 0.4, 'uav-hstab');
        s += text(cx + 6, cy - fr - finH + 4, 'fin', 'uav-fig-label');
      }
    }
    // dihedral label
    s += text(cx + half * scale * 0.55, cy - fr - tipRise * scale * 0.55 - 8, 'dihedral ' + fmt(d.dihedral, 1) + '°', 'uav-fig-label', 'middle');
    s += text(cx, cy + propR * scale + 14, 'prop ⌀ ' + fmt(d.propDiameter, 1) + ' in', 'uav-fig-label', 'middle');
    s += '</svg>';
    document.getElementById('uav-front-view').innerHTML = s;
  }

  /* ── airfoil section (NACA-4-digit-style reconstruction) ─────────────── */
  function renderAirfoil(d, r) {
    var foil = r.foil;
    var m = foil.camber / 100, p = Math.max(0.05, foil.camberPos / 100), tt = foil.thickness / 100;
    var W = 640, H = 180, pad = 24;
    var chord = W - 2 * pad, y0 = H * 0.62;
    function yt(x) {
      return 5 * tt * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
    }
    function yc(x) {
      if (m === 0) return 0;
      return x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x);
    }
    var up = [], lo = [], cam = [];
    for (var i = 0; i <= 60; i++) {
      var x = i / 60;
      var xc = 0.5 * (1 - Math.cos(Math.PI * x)); // cosine spacing
      var c = yc(xc), t = yt(xc);
      up.push([pad + xc * chord, y0 - (c + t) * chord]);
      lo.push([pad + xc * chord, y0 - (c - t) * chord]);
      cam.push([pad + xc * chord, y0 - c * chord]);
    }
    function pathOf(pts) {
      return pts.map(function (pt, idx) { return (idx ? 'L ' : 'M ') + f2(pt[0]) + ' ' + f2(pt[1]); }).join(' ');
    }
    var s = svgOpen(W, H);
    s += '<title>' + esc(foil.label) + ' section profile</title>';
    s += line(pad, y0, pad + chord, y0, 'uav-macline');
    s += path(pathOf(up) + ' ' + pathOf(lo.slice().reverse()).replace(/^M/, 'L') + ' Z', 'uav-foil');
    if (m > 0) s += path(pathOf(cam), 'uav-camberline');
    s += text(pad, 18, foil.label + ' — t/c ' + fmt(foil.thickness, 1) + ' %, camber ' + fmt(foil.camber, 1) + ' % @ ' + fmt(foil.camberPos, 0) + ' %', 'uav-fig-label');
    s += text(pad, 34, 'cl₀ ' + fmt(foil.cl0, 2) + ' · cl max ' + fmt(foil.clmax, 2) + ' · cd₀ ' + fmt(foil.cd0, 4) + ' · cm ' + fmt(foil.cm, 3), 'uav-fig-label');
    s += '</svg>';
    document.getElementById('uav-airfoil-view').innerHTML = s;
    document.getElementById('uav-airfoil-caption').textContent =
      'FIG 4 — wing section: ' + foil.label + ' (' + foil.use + '). Outline reconstructed from camber/thickness parameters' +
      (d.airfoil.indexOf('naca') === 0 ? '.' : ' — approximate for non-NACA sections; polar data from published low-Re tests.');
  }

  /* ── 3-D preview ──────────────────────────────────────────────────────
   * Tiny software renderer, no libraries: the parametric geometry is lofted
   * into ~170 flat-shaded polygons, depth-sorted (painter's algorithm), and
   * drawn to a canvas. Drag to orbit; auto-rotates until grabbed.
   * Coordinates: x aft from the nose, y to starboard, z up (meters).
   */
  var view3D = { yaw: -0.6, pitch: -0.42, auto: true, mesh: null, canvas: null, ctx: null, ro: null };

  var THEME3D = {
    light: {
      wing: [216, 216, 208], fus: [201, 201, 193], tail: [208, 208, 200],
      edge: 'rgba(30,30,30,0.55)', prop: 'rgba(200,64,26,0.10)', propEdge: 'rgba(200,64,26,0.5)'
    },
    dark: {
      wing: [96, 112, 134], fus: [76, 90, 110], tail: [110, 126, 148],
      edge: 'rgba(231,234,240,0.4)', prop: 'rgba(53,201,234,0.10)', propEdge: 'rgba(53,201,234,0.55)'
    }
  };

  function foilShapeFns(foil) {
    var m = foil.camber / 100, p = Math.max(0.05, foil.camberPos / 100), tt = foil.thickness / 100;
    return {
      camber: function (f) {
        if (m === 0) return 0;
        return f < p ? m / (p * p) * (2 * p * f - f * f) : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * f - f * f);
      },
      thick: function (f) {
        return 5 * tt * (0.2969 * Math.sqrt(f) - 0.1260 * f - 0.3516 * f * f + 0.2843 * f * f * f - 0.1015 * f * f * f * f);
      }
    };
  }

  function build3DMesh(d, r) {
    var L = layout(d, r);
    var faces = [];
    var fusR = d.fusDiameter / 2;
    var zWing = fusR * 0.85;
    var shape = foilShapeFns(r.foil);
    var tanDi = Math.tan(d.dihedral * Math.PI / 180);

    function quad(a, b, c, e, part) { faces.push({ pts: [a, b, c, e], part: part }); }
    function polyFace(pts, part) { faces.push({ pts: pts, part: part }); }

    // wing: airfoil-sectioned strips, both halves
    var chordFr = [0, 0.12, 0.35, 0.65, 1];
    var nSpan = 6;
    [1, -1].forEach(function (side) {
      var secs = [];
      for (var i = 0; i <= nSpan; i++) {
        var t = i / nSpan;
        var y = side * t * d.span / 2;
        var chord = d.rootChord * (1 - (1 - d.taper) * t);
        var xLE = L.wingRootLE + Math.abs(y) * L.sweepTan;
        var z0 = zWing + Math.abs(y) * tanDi;
        var up = [], lo = [];
        chordFr.forEach(function (f) {
          var xc = xLE + f * chord;
          up.push([xc, y, z0 + (shape.camber(f) + shape.thick(f)) * chord]);
          lo.push([xc, y, z0 + (shape.camber(f) - shape.thick(f)) * chord]);
        });
        secs.push({ up: up, lo: lo });
      }
      for (var s = 0; s < nSpan; s++) {
        for (var j = 0; j < chordFr.length - 1; j++) {
          quad(secs[s].up[j], secs[s].up[j + 1], secs[s + 1].up[j + 1], secs[s + 1].up[j], 'wing');
          quad(secs[s].lo[j], secs[s + 1].lo[j], secs[s + 1].lo[j + 1], secs[s].lo[j + 1], 'wing');
        }
      }
      var tip = secs[nSpan];
      polyFace(tip.up.concat(tip.lo.slice().reverse()), 'wing');
    });

    // fuselage: lofted rings
    var rProf = [0, 0.55, 0.85, 1, 0.95, 0.8, 0.5, 0.22];
    var xProf = [0, 0.05, 0.15, 0.32, 0.52, 0.7, 0.86, 1];
    var nSeg = 8;
    var rings = xProf.map(function (fx, i) {
      var ring = [];
      for (var k = 0; k < nSeg; k++) {
        var a = k / nSeg * 2 * Math.PI;
        ring.push([fx * d.fusLength, Math.cos(a) * rProf[i] * fusR, Math.sin(a) * rProf[i] * fusR]);
      }
      return ring;
    });
    for (var ri = 0; ri < rings.length - 1; ri++) {
      for (var k = 0; k < nSeg; k++) {
        var k2 = (k + 1) % nSeg;
        quad(rings[ri][k], rings[ri][k2], rings[ri + 1][k2], rings[ri + 1][k], 'fus');
      }
    }

    // tail boom when the tail sits behind the fuselage (not flying wing)
    var zTailBase = fusR * 0.35;
    function plate(cornerFn, part) { polyFace(cornerFn, part); }
    if (r.tail.type !== 'flyingwing') {
      var boomEnd = L.xTailC4 + 0.75 * L.chRoot;
      if (boomEnd > d.fusLength) {
        var bw = Math.max(0.006, 0.008 * d.span);
        quad([d.fusLength - 0.02, -bw, 0], [boomEnd, -bw, 0], [boomEnd, bw, 0], [d.fusLength - 0.02, bw, 0], 'fus');
        quad([d.fusLength - 0.02, 0, -bw], [boomEnd, 0, -bw], [boomEnd, 0, bw], [d.fusLength - 0.02, 0, bw], 'fus');
      }
    }

    // tail surfaces by configuration (thin plates, two-sided shading)
    var thLE = L.xTailC4 - 0.25 * L.chRoot;
    if (r.tail.type === 'flyingwing') {
      // winglets at the swept tips
      [1, -1].forEach(function (side) {
        var yTip = side * d.span / 2;
        var xTipLE = L.wingRootLE + (d.span / 2) * L.sweepTan;
        var zTip = zWing + (d.span / 2) * tanDi;
        plate([
          [xTipLE, yTip, zTip],
          [xTipLE + 0.45 * L.cvRoot, yTip, zTip + L.hv],
          [xTipLE + 0.45 * L.cvRoot + L.cvTip, yTip, zTip + L.hv],
          [xTipLE + L.cvRoot, yTip, zTip]
        ], 'tail');
      });
    } else if (r.tail.type === 'vtail') {
      [1, -1].forEach(function (side) {
        var dy = side * Math.cos(L.gamma) * r.tail.span / 2;
        var dz = Math.sin(L.gamma) * r.tail.span / 2;
        plate([
          [thLE, 0, zTailBase],
          [thLE + (L.chRoot - L.chTip) / 2, dy, zTailBase + dz],
          [thLE + (L.chRoot + L.chTip) / 2, dy, zTailBase + dz],
          [thLE + L.chRoot, 0, zTailBase]
        ], 'tail');
      });
    } else {
      var finTopZ = zTailBase + L.hv;
      var finLE = L.xTailC4 - 0.25 * L.cvRoot;
      plate([
        [finLE - 0.35 * L.cvRoot, 0, zTailBase],
        [finLE + 0.45 * L.cvRoot, 0, finTopZ],
        [finLE + 0.45 * L.cvRoot + L.cvTip, 0, finTopZ],
        [finLE + 1.05 * L.cvRoot, 0, zTailBase]
      ], 'tail');
      var hz = r.tail.type === 'ttail' ? finTopZ : zTailBase;
      [1, -1].forEach(function (side) {
        var yT = side * L.bhDraw / 2;
        plate([
          [thLE, 0, hz],
          [thLE + (L.chRoot - L.chTip) / 2, yT, hz],
          [thLE + (L.chRoot + L.chTip) / 2, yT, hz],
          [thLE + L.chRoot, 0, hz]
        ], 'tail');
      });
    }

    // prop disk at the nose
    var propR = d.propDiameter * 0.0254 / 2;
    var disk = [];
    for (var pa = 0; pa < 20; pa++) {
      var ang = pa / 20 * 2 * Math.PI;
      disk.push([-0.01, Math.cos(ang) * propR, Math.sin(ang) * propR]);
    }
    polyFace(disk, 'prop');

    // fit data
    var half = d.span / 2;
    var height = Math.max(propR, fusR + half * Math.abs(tanDi) + 0.1 * d.span);
    return { faces: faces, span: d.span, length: r.totalLength, height: height,
             cx: r.totalLength / 2, theme: document.body.dataset.uavTheme === 'dark' ? 'dark' : 'light' };
  }

  function render3D() {
    var v = view3D;
    if (!v.canvas || !v.mesh) return;
    var cw = v.canvas.clientWidth || 640;
    var ch = Math.round(cw * 0.62);
    var dpr = window.devicePixelRatio || 1;
    if (v.canvas.width !== cw * dpr || v.canvas.height !== ch * dpr) {
      v.canvas.width = cw * dpr;
      v.canvas.height = ch * dpr;
    }
    var ctx = v.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    var m = v.mesh;
    var cosY = Math.cos(v.yaw), sinY = Math.sin(v.yaw);
    var cosP = Math.cos(v.pitch), sinP = Math.sin(v.pitch);
    var maxDim = Math.max(m.span, m.length, m.height * 2) || 1;
    var scale = 0.82 * Math.min(cw, ch * 1.6) / maxDim;
    var ox = cw / 2, oy = ch / 2;

    function proj(p) {
      var x = p[0] - m.cx, y = p[1], z = p[2];
      var x1 = x * cosY - y * sinY;
      var y1 = x * sinY + y * cosY;
      var y2 = y1;
      var z2 = z * cosP - x1 * sinP;
      var depth = x1 * cosP + z * sinP;
      return [ox + y2 * scale, oy - z2 * scale, depth];
    }

    var theme = THEME3D[m.theme] || THEME3D.light;
    var light = [0.35, -0.5, 0.79]; // camera-space light
    var drawn = [];
    m.faces.forEach(function (f) {
      var pts = f.pts.map(proj);
      var depth = 0;
      pts.forEach(function (p) { depth += p[2]; });
      // face normal in projected space for shading (two-sided)
      var ax = pts[1][0] - pts[0][0], ay = pts[1][1] - pts[0][1], az = pts[1][2] - pts[0][2];
      var bx = pts[2][0] - pts[0][0], by = pts[2][1] - pts[0][1], bz = pts[2][2] - pts[0][2];
      var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      var shade = 0.55 + 0.45 * Math.abs((nx * light[0] + ny * light[1] + nz * light[2]) / nl);
      drawn.push({ pts: pts, depth: depth / pts.length, part: f.part, shade: shade });
    });
    drawn.sort(function (a, b) { return a.depth - b.depth; });

    drawn.forEach(function (f) {
      ctx.beginPath();
      f.pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath();
      if (f.part === 'prop') {
        ctx.fillStyle = theme.prop;
        ctx.strokeStyle = theme.propEdge;
        ctx.setLineDash([4, 4]);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      var c = theme[f.part] || theme.fus;
      ctx.fillStyle = 'rgb(' + Math.round(c[0] * f.shade) + ',' + Math.round(c[1] * f.shade) + ',' + Math.round(c[2] * f.shade) + ')';
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = 0.6;
      ctx.fill();
      ctx.stroke();
    });
  }

  function setup3D() {
    var canvas = document.getElementById('uav-3d-view');
    if (!canvas) return;
    view3D.canvas = canvas;
    view3D.ctx = canvas.getContext('2d');

    var dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      view3D.auto = false;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      view3D.yaw += (e.clientX - lastX) * 0.008;
      view3D.pitch = Math.max(-1.35, Math.min(1.35, view3D.pitch - (e.clientY - lastY) * 0.008));
      lastX = e.clientX; lastY = e.clientY;
      render3D();
    });
    canvas.addEventListener('pointerup', function () { dragging = false; });
    canvas.addEventListener('pointercancel', function () { dragging = false; });

    if ('ResizeObserver' in window) {
      view3D.ro = new ResizeObserver(function () { render3D(); });
      view3D.ro.observe(canvas);
    }
    (function tick() {
      if (view3D.auto && !document.hidden && canvas.clientWidth) {
        view3D.yaw += 0.004;
        render3D();
      }
      requestAnimationFrame(tick);
    }());
  }

  /* ── chart scaffolding ───────────────────────────────────────────────── */
  function niceTicks(min, max, n) {
    var span = max - min;
    if (!(span > 0)) return [min];
    var step = Math.pow(10, Math.floor(Math.log10(span / n)));
    var err = span / n / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function chartFrame(W, H, M, xmin, xmax, ymin, ymax, xlabel, ylabel) {
    var xt = niceTicks(xmin, xmax, 6), yt2 = niceTicks(ymin, ymax, 5);
    function X(v) { return M.l + (v - xmin) / (xmax - xmin) * (W - M.l - M.r); }
    function Y(v) { return H - M.b - (v - ymin) / (ymax - ymin) * (H - M.t - M.b); }
    var s = '';
    yt2.forEach(function (v) { s += line(M.l, Y(v), W - M.r, Y(v), 'uav-grid'); });
    xt.forEach(function (v) { s += line(X(v), H - M.b, X(v), M.t, 'uav-grid'); });
    s += line(M.l, H - M.b, W - M.r, H - M.b, 'uav-axis');
    s += line(M.l, H - M.b, M.l, M.t, 'uav-axis');
    xt.forEach(function (v) { s += text(X(v), H - M.b + 16, String(v), 'uav-tick', 'middle'); });
    yt2.forEach(function (v) { s += text(M.l - 6, Y(v) + 3, String(v), 'uav-tick', 'end'); });
    s += text((M.l + W - M.r) / 2, H - 6, xlabel, 'uav-axis-label', 'middle');
    s += '<text x="14" y="' + f2((M.t + H - M.b) / 2) + '" class="uav-axis-label" text-anchor="middle" transform="rotate(-90 14 ' + f2((M.t + H - M.b) / 2) + ')">' + esc(ylabel) + '</text>';
    return { svg: s, X: X, Y: Y };
  }

  function seriesPath(pts, X, Y, cls) {
    var dstr = '', pen = false;
    pts.forEach(function (pt) {
      if (!isFinite(pt[1]) || isNaN(pt[1])) { pen = false; return; }
      dstr += (pen ? ' L ' : ' M ') + f2(X(pt[0])) + ' ' + f2(Y(pt[1]));
      pen = true;
    });
    return path(dstr.trim(), cls);
  }

  /* ── power vs airspeed chart ─────────────────────────────────────────── */
  var powerChartCtx = null; // kept for hover lookups

  function renderPowerChart(d, r) {
    var W = 640, H = 340, M = { l: 56, r: 16, t: 18, b: 44 };
    var vMin = Math.max(1, r.vstall * 0.85);
    var vMax = Math.max(2 * r.vLdMax, 1.4 * d.cruiseSpeed, r.vstall * 1.8);
    var pts = [];
    var pMaxSeen = d.maxPower;
    for (var i = 0; i <= 120; i++) {
      var v = vMin + (vMax - vMin) * i / 120;
      var p = powerElecAt(d, r, v);
      pts.push([v, p]);
      if (isFinite(p) && p > pMaxSeen) pMaxSeen = p;
    }
    var yMax = Math.min(pMaxSeen * 1.15, Math.max(d.maxPower * 2.5, 10));
    var fr = chartFrame(W, H, M, vMin, vMax, 0, yMax, 'airspeed (m/s)', 'electrical power (W)');
    var s = svgOpen(W, H) + '<title>Electrical power required vs airspeed, against maximum power</title>' + fr.svg;
    s += '<clipPath id="uav-power-clip"><rect x="' + M.l + '" y="' + M.t + '" width="' + (W - M.l - M.r) + '" height="' + (H - M.t - M.b) + '"/></clipPath>';

    // stall boundary
    s += line(fr.X(r.vstall), fr.Y(0), fr.X(r.vstall), M.t, 'uav-stall-line');
    s += text(fr.X(r.vstall) + 4, M.t + 12, 'stall ' + fmt(r.vstall, 1), 'uav-fig-label uav-fig-label-accent');
    // series: required (solid ink) + available (dashed accent) — dash pattern is
    // the color-independent encoding; both series carry direct labels.
    if (d.maxPower <= yMax) {
      s += line(fr.X(vMin), fr.Y(d.maxPower), fr.X(vMax), fr.Y(d.maxPower), 'uav-series-avail');
      s += text(fr.X(vMax) - 4, fr.Y(d.maxPower) - 6, 'P max ' + fmtInt(d.maxPower) + ' W', 'uav-series-label uav-series-label-accent', 'end');
    }
    s += '<g clip-path="url(#uav-power-clip)">' + seriesPath(pts, fr.X, fr.Y, 'uav-series-req') + '</g>';
    var lastP = pts[pts.length - 1][1];
    var labelY = Math.max(M.t + 12, Math.min(H - M.b - 6, fr.Y(lastP) - 8));
    s += text(fr.X(vMax) - 4, labelY, 'P required', 'uav-series-label', 'end');
    // cruise marker
    var pc = r.cruisePowerE;
    if (isFinite(pc) && pc <= yMax) {
      s += '<circle cx="' + f2(fr.X(d.cruiseSpeed)) + '" cy="' + f2(fr.Y(pc)) + '" r="4" class="uav-marker"/>';
      s += text(fr.X(d.cruiseSpeed) + 7, fr.Y(pc) + 3, 'cruise', 'uav-fig-label');
    }
    s += '<rect class="uav-hover-target" x="' + M.l + '" y="' + M.t + '" width="' + (W - M.l - M.r) + '" height="' + (H - M.t - M.b) + '"/>';
    s += '</svg>';
    var host = document.getElementById('uav-power-chart');
    host.innerHTML = s;
    powerChartCtx = { W: W, H: H, M: M, vMin: vMin, vMax: vMax, yMax: yMax, d: d, r: r, fr: fr, host: host };
    attachPowerHover(host);
  }

  function attachPowerHover(host) {
    var svg = host.querySelector('svg');
    var tip = document.getElementById('uav-chart-tip');
    var cross = null;
    svg.addEventListener('pointermove', function (e) {
      var c = powerChartCtx;
      if (!c) return;
      var rect = svg.getBoundingClientRect();
      var fx = (e.clientX - rect.left) / rect.width * c.W;
      if (fx < c.M.l || fx > c.W - c.M.r) { hide(); return; }
      var v = c.vMin + (fx - c.M.l) / (c.W - c.M.l - c.M.r) * (c.vMax - c.vMin);
      var p = powerElecAt(c.d, c.r, v);
      if (!cross) {
        cross = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        cross.setAttribute('class', 'uav-crosshair');
        svg.appendChild(cross);
      }
      cross.setAttribute('x1', f2(c.fr.X(v))); cross.setAttribute('x2', f2(c.fr.X(v)));
      cross.setAttribute('y1', f2(c.M.t)); cross.setAttribute('y2', f2(c.H - c.M.b));
      cross.style.display = '';
      tip.style.display = 'block';
      tip.textContent = fmt(v, 1) + ' m/s · ' + (isNaN(p) ? 'below stall' :
        'P req ' + fmt(p, 1) + ' W · margin ' + fmt(c.d.maxPower - p, 0) + ' W');
      var hostRect = host.getBoundingClientRect();
      var lx = e.clientX - hostRect.left + 12;
      if (lx > hostRect.width - 190) lx = e.clientX - hostRect.left - 195;
      tip.style.left = lx + 'px';
      tip.style.top = (e.clientY - hostRect.top - 28) + 'px';
    });
    svg.addEventListener('pointerleave', hide);
    function hide() {
      tip.style.display = 'none';
      if (cross) cross.style.display = 'none';
    }
  }

  /* ── drag polar chart ────────────────────────────────────────────────── */
  function renderPolarChart(d, r) {
    var W = 640, H = 340, M = { l: 56, r: 16, t: 18, b: 44 };
    var pts = [];
    for (var i = 0; i <= 80; i++) {
      var cl = r.clMax3D * i / 80;
      pts.push([r.cd0 + r.k * cl * cl, cl]);
    }
    var cdMax = r.cd0 + r.k * r.clMax3D * r.clMax3D;
    var fr = chartFrame(W, H, M, 0, cdMax * 1.05, 0, r.clMax3D * 1.1, 'CD (total)', 'CL');
    var s = svgOpen(W, H) + '<title>Drag polar with cruise and best-glide points</title>' + fr.svg;
    s += seriesPath(pts, fr.X, fr.Y, 'uav-series-req');
    // best L/D tangent point
    var clStar = Math.sqrt(r.cd0 / r.k);
    if (clStar <= r.clMax3D) {
      var cdStar = 2 * r.cd0;
      s += '<circle cx="' + f2(fr.X(cdStar)) + '" cy="' + f2(fr.Y(clStar)) + '" r="4" class="uav-np"/>';
      s += text(fr.X(cdStar) + 7, fr.Y(clStar) + 3, 'L/D max ' + fmt(r.ldMax, 1), 'uav-fig-label uav-fig-label-accent');
    }
    // cruise point
    var cdc = r.cd0 + r.k * r.clCruise * r.clCruise;
    if (r.clCruise <= r.clMax3D) {
      s += '<circle cx="' + f2(fr.X(cdc)) + '" cy="' + f2(fr.Y(r.clCruise)) + '" r="4" class="uav-marker"/>';
      s += text(fr.X(cdc) + 7, fr.Y(r.clCruise) + 3, 'cruise L/D ' + fmt(r.ldCruise, 1), 'uav-fig-label');
    }
    s += text(fr.X(r.cd0) + 4, fr.Y(0) - 8, 'CD₀ ' + fmt(r.cd0, 4), 'uav-fig-label');
    s += '</svg>';
    document.getElementById('uav-polar-chart').innerHTML = s;
  }

  /* ── sensitivity analysis (learning tool) ────────────────────────────── */
  var SENS_METRICS = ['vstall', 'ldMax', 'endurance', 'range', 'roc', 'staticMargin'];

  function renderSensitivity(base) {
    var head = document.getElementById('uav-sens-head');
    var body = document.getElementById('uav-sens-body');
    var hh = '<tr><th>Parameter (+10 %)</th>';
    SENS_METRICS.forEach(function (k) {
      hh += '<th class="num">' + esc(metricByKey[k].label) + '</th>';
    });
    head.innerHTML = hh + '</tr>';

    var html = '';
    GROUPS.forEach(function (g) {
      PARAMS.filter(function (p) { return p.group === g.id && !p.options && paramRelevant(p.key, design); }).forEach(function (p) {
        var v = design[p.key];
        // +10% of current value; for a zero value, +10% of the parameter's range
        var dv = v !== 0 ? 0.1 * Math.abs(v) : 0.1 * (p.max - p.min);
        var v2 = Math.min(p.max, v + dv);
        if (v2 === v) return; // pinned at the upper bound — no room to perturb
        var t = {};
        PARAMS.forEach(function (q) { t[q.key] = design[q.key]; });
        t[p.key] = v2;
        var r2 = derive(t);
        html += '<tr><td>' + esc(p.label) + (v === 0 ? ' <span class="desc">(from 0: +10 % of range)</span>' : '') + '</td>';
        SENS_METRICS.forEach(function (k) {
          var b = base[k], n = r2[k];
          var pct = (isFinite(b) && b !== 0 && isFinite(n)) ? 100 * (n - b) / Math.abs(b) : NaN;
          var cls = 'num';
          if (isFinite(pct)) {
            if (Math.abs(pct) >= 5) cls += ' uav-sens-hi';
            else if (Math.abs(pct) < 0.5) cls += ' uav-sens-lo';
          }
          html += '<td class="' + cls + '">' + (isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + ' %' : DASH) + '</td>';
        });
        html += '</tr>';
      });
    });
    body.innerHTML = html;
  }

  /* ── parameter physics reference (generated from the registry) ───────── */
  function renderParamReference() {
    var body = document.getElementById('uav-ref-body');
    var html = '';
    GROUPS.forEach(function (g) {
      PARAMS.filter(function (p) { return p.group === g.id; }).forEach(function (p) {
        html += '<tr><td class="uav-ref-name">' + esc(p.label) + '</td>' +
          '<td class="uav-ref-unit">' + esc(p.unit) + '</td>' +
          '<td class="uav-ref-group">' + esc(g.label) + '</td>' +
          '<td class="desc">' + esc(p.teach || '') + '</td></tr>';
      });
    });
    body.innerHTML = html;
  }

  /* ── design file save / load ─────────────────────────────────────────── */
  function designFileFrom(source, name) {
    var params = {};
    PARAMS.forEach(function (p) { params[p.key] = source[p.key]; });
    return {
      schema: SCHEMA,
      name: name || document.getElementById('uav-design-name').value.trim() || 'unnamed-uav',
      saved: new Date().toISOString(),
      params: params
    };
  }

  function designFile() {
    return designFileFrom(design);
  }

  function downloadDesignFile(file) {
    var blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase() + '.uav.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return a.download;
  }

  function saveDesign() {
    var file = designFile();
    var saved = downloadDesignFile(file);
    setFileStatus('Saved ' + saved + ' — ' + file.saved);
  }

  // apply a parsed design file to the working design; shared by file load
  // and localStorage restore
  function applyDesignData(data) {
    if (data.schema !== SCHEMA) throw new Error('unknown schema "' + data.schema + '" (expected ' + SCHEMA + ')');
    var applied = 0, skipped = [];
    PARAMS.forEach(function (p) {
      var v = data.params ? data.params[p.key] : undefined;
      if (v === undefined) { skipped.push(p.key); return; }
      if (p.options) {
        if (p.options[v]) { design[p.key] = v; applied++; } else skipped.push(p.key);
      } else {
        v = parseFloat(v);
        if (isFinite(v)) { design[p.key] = Math.min(p.max, Math.max(p.min, v)); applied++; }
        else skipped.push(p.key);
      }
    });
    if (data.name) document.getElementById('uav-design-name').value = String(data.name).slice(0, 60);
    activePreset = { airframe: null, motor: null, battery: null };
    renderPresetStatus();
    return { applied: applied, skipped: skipped };
  }

  function loadDesign(fileObj) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var res = applyDesignData(data);
        designTouched = true;
        syncForm();
        recompute();
        setFileStatus('Loaded "' + (data.name || 'unnamed') + '" — ' + res.applied + ' parameters applied' +
          (res.skipped.length ? ', defaults kept for: ' + res.skipped.join(', ') : ''));
      } catch (err) {
        setFileStatus('Load failed: ' + err.message);
      }
    };
    reader.readAsText(fileObj);
  }

  function setFileStatus(msg) {
    document.getElementById('uav-file-status').textContent = msg;
  }

  /* ── localStorage autosave (device-local; refresh-safe working copy) ───
   * Nothing is stored until the visitor actually edits the design — an
   * untouched page leaves no trace.
   */
  var designTouched = false;

  function autosave() {
    if (!designTouched) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(designFile()));
    } catch (err) {
      /* private browsing or quota — the page still works, just without persistence */
    }
  }

  function restoreAutosave() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      applyDesignData(data);
      designTouched = true;
      setFileStatus('Restored working design "' + (data.name || 'unnamed') + '" autosaved ' +
        (data.saved || 'earlier') + ' in this browser. Reset defaults discards it.');
      return true;
    } catch (err) {
      return false;
    }
  }

  function clearAutosave() {
    try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
  }

  /* ── Monte Carlo design search ───────────────────────────────────────── */
  // Parameters excluded from the default vary set: component-quality and
  // environment inputs the optimizer would simply run to their favorable end
  // (lighter structure and better efficiency are always "better" — sampling
  // them yields optimism, not design insight). They remain one click away.
  var MC_DEFAULT_OFF = {
    structure: 1, avionics: 1, propMass: 1, oswald: 1,
    etaProp: 1, etaMotor: 1, battDensity: 1, usableBatt: 1, altitude: 1
  };

  function mcOptionList() {
    // anything numeric — parameter or derived metric — can be constrained,
    // optimized, or plotted
    var opts = [];
    PARAMS.forEach(function (p) {
      if (!p.options) opts.push({ key: p.key, label: p.label + ' [input, ' + p.unit + ']' });
    });
    METRICS.forEach(function (m) {
      opts.push({ key: m.key, label: m.label + ' [derived, ' + m.unit + ']' });
    });
    return opts;
  }

  function optionHtml(selected) {
    return mcOptionList().map(function (o) {
      return '<option value="' + o.key + '"' + (o.key === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  function buildMcVaryTable() {
    var body = document.getElementById('uav-mc-vary-body');
    var html = '';
    PARAMS.forEach(function (p) {
      if (p.options) return;
      var on = !MC_DEFAULT_OFF[p.key];
      html += '<tr>' +
        '<td class="uav-mc-check"><input type="checkbox" data-mc-vary="' + p.key + '" id="mcv-' + p.key + '"' + (on ? ' checked' : '') + '></td>' +
        '<td><label for="mcv-' + p.key + '">' + esc(p.label) + '</label> <span class="desc">(' + esc(p.unit) + ')</span></td>' +
        '<td class="num" data-mc-current="' + p.key + '"></td>' +
        '<td><input type="number" data-mc-min="' + p.key + '" step="' + p.step + '" autocomplete="off"></td>' +
        '<td><input type="number" data-mc-max="' + p.key + '" step="' + p.step + '" autocomplete="off"></td>' +
        '</tr>';
    });
    body.innerHTML = html;
    // seed ranges for the default-checked set
    PARAMS.forEach(function (p) {
      if (!p.options && !MC_DEFAULT_OFF[p.key]) seedMcRange(p.key);
    });
    body.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-mc-vary');
      if (!key) return;
      if (e.target.checked) seedMcRange(key);
    });
    document.getElementById('uav-mc-vary-all').addEventListener('click', function () {
      document.querySelectorAll('[data-mc-vary]').forEach(function (cb) {
        if (cb.disabled) return; // configuration-irrelevant parameters stay out
        cb.checked = true;
        seedMcRange(cb.getAttribute('data-mc-vary'));
      });
    });
    document.getElementById('uav-mc-vary-none').addEventListener('click', function () {
      document.querySelectorAll('[data-mc-vary]').forEach(function (cb) { cb.checked = false; });
    });
  }

  function seedMcRange(key) {
    var p = paramByKey[key];
    var cur = design[key];
    var lo = Math.max(p.min, cur * 0.7), hi = Math.min(p.max, cur * 1.3 || p.min + (p.max - p.min) * 0.1);
    if (cur === 0) { lo = p.min; hi = p.min + 0.3 * (p.max - p.min); }
    var minEl = document.querySelector('[data-mc-min="' + key + '"]');
    var maxEl = document.querySelector('[data-mc-max="' + key + '"]');
    if (!minEl.value) minEl.value = +lo.toFixed(Math.max(3, decimalsOf(p.step)));
    if (!maxEl.value) maxEl.value = +hi.toFixed(Math.max(3, decimalsOf(p.step)));
  }

  function syncMcCurrents() {
    PARAMS.forEach(function (p) {
      if (p.options) return;
      var el = document.querySelector('[data-mc-current="' + p.key + '"]');
      if (el) el.textContent = fmt(design[p.key], decimalsOf(p.step));
    });
  }

  function addConstraintRow(key, min, max) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><select data-c-key>' + optionHtml(key || 'staticMargin') + '</select></td>' +
      '<td><input type="number" data-c-min step="any" value="' + (min !== undefined ? min : '') + '" autocomplete="off" placeholder="no min"></td>' +
      '<td><input type="number" data-c-max step="any" value="' + (max !== undefined ? max : '') + '" autocomplete="off" placeholder="no max"></td>' +
      '<td class="uav-mc-check"><button type="button" class="tools-button" data-c-remove>remove</button></td>';
    tr.querySelector('[data-c-remove]').addEventListener('click', function () { tr.remove(); });
    document.getElementById('uav-mc-constraints-body').appendChild(tr);
  }

  function addObjectiveRow(key, dir, weight) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><select data-o-key>' + optionHtml(key || 'endurance') + '</select></td>' +
      '<td><select data-o-dir>' +
        '<option value="max"' + (dir !== 'min' ? ' selected' : '') + '>maximize</option>' +
        '<option value="min"' + (dir === 'min' ? ' selected' : '') + '>minimize</option></select></td>' +
      '<td><input type="number" data-o-weight step="any" min="0" value="' + (weight !== undefined ? weight : 1) + '" autocomplete="off"></td>' +
      '<td class="uav-mc-check"><button type="button" class="tools-button" data-o-remove>remove</button></td>';
    tr.querySelector('[data-o-remove]').addEventListener('click', function () { tr.remove(); });
    document.getElementById('uav-mc-objectives-body').appendChild(tr);
  }

  function readMcConfig() {
    var varied = [];
    document.querySelectorAll('[data-mc-vary]').forEach(function (cb) {
      if (!cb.checked || cb.disabled) return;
      var key = cb.getAttribute('data-mc-vary');
      var p = paramByKey[key];
      var lo = parseFloat(document.querySelector('[data-mc-min="' + key + '"]').value);
      var hi = parseFloat(document.querySelector('[data-mc-max="' + key + '"]').value);
      if (!isFinite(lo)) lo = p.min;
      if (!isFinite(hi)) hi = p.max;
      lo = Math.max(p.min, Math.min(lo, hi));
      hi = Math.min(p.max, Math.max(lo, hi));
      varied.push({ key: key, min: lo, max: hi });
    });
    var constraints = [];
    document.querySelectorAll('#uav-mc-constraints-body tr').forEach(function (tr) {
      var key = tr.querySelector('[data-c-key]').value;
      var lo = parseFloat(tr.querySelector('[data-c-min]').value);
      var hi = parseFloat(tr.querySelector('[data-c-max]').value);
      if (!isFinite(lo) && !isFinite(hi)) return;
      constraints.push({ key: key, min: isFinite(lo) ? lo : -Infinity, max: isFinite(hi) ? hi : Infinity });
    });
    var objectives = [];
    document.querySelectorAll('#uav-mc-objectives-body tr').forEach(function (tr) {
      var w = parseFloat(tr.querySelector('[data-o-weight]').value);
      if (!isFinite(w) || w <= 0) w = 1;
      objectives.push({
        key: tr.querySelector('[data-o-key]').value,
        dir: tr.querySelector('[data-o-dir]').value,
        weight: w
      });
    });
    return {
      varied: varied,
      constraints: constraints,
      objectives: objectives,
      samples: Math.min(100000, Math.max(50, parseInt(document.getElementById('uav-mc-samples').value, 10) || 3000))
    };
  }

  function valueOf(sampleParams, r, key) {
    if (key in r && typeof r[key] === 'number') return r[key];
    if (key in sampleParams) return sampleParams[key];
    return NaN;
  }

  function runMonteCarlo() {
    var cfg = readMcConfig();
    var statusEl = document.getElementById('uav-mc-status');
    if (!cfg.varied.length) {
      statusEl.textContent = 'Select at least one parameter to vary.';
      return;
    }
    if (!cfg.objectives.length) {
      statusEl.textContent = 'Add at least one objective.';
      return;
    }
    // snapshot the working design: every sample is base + varied overrides,
    // so the best sample can be reconstructed exactly from its varied values
    var base = {};
    PARAMS.forEach(function (p) { base[p.key] = design[p.key]; });
    var points = [];
    var feasible = 0;
    var nearMiss = null, nearMissViolation = Infinity;
    var t0 = performance.now();
    for (var i = 0; i < cfg.samples; i++) {
      var sample = {};
      PARAMS.forEach(function (p) { sample[p.key] = base[p.key]; });
      cfg.varied.forEach(function (vp) {
        var pd = paramByKey[vp.key];
        var v = vp.min + Math.random() * (vp.max - vp.min);
        // snap to the parameter's step so sampled, displayed, applied, and
        // saved values are the same number
        v = +(Math.round(v / pd.step) * pd.step).toFixed(6);
        sample[vp.key] = Math.min(pd.max, Math.max(pd.min, v));
      });
      var r = derive(sample);
      var ok = true, violation = 0;
      cfg.constraints.forEach(function (c) {
        var v = valueOf(sample, r, c.key);
        if (!isFinite(v)) { ok = false; violation += 10; return; }
        if (v < c.min) { ok = false; violation += (c.min - v) / Math.max(1e-9, Math.abs(c.min)); }
        else if (v > c.max) { ok = false; violation += (v - c.max) / Math.max(1e-9, Math.abs(c.max)); }
      });
      if (ok) feasible++;
      else if (violation < nearMissViolation) {
        nearMissViolation = violation;
        nearMiss = cfg.constraints.map(function (c) {
          var v = valueOf(sample, r, c.key);
          if (isFinite(v) && v >= c.min && v <= c.max) return null;
          var side = (isFinite(v) && v < c.min) ? 'min' : 'max';
          var bound = side === 'min' ? c.min : c.max;
          return { key: c.key, value: v, bound: bound, side: side,
            rel: isFinite(v) ? Math.abs(v - bound) / Math.max(1e-9, Math.abs(bound)) : 10 };
        }).filter(Boolean)
          // lead with what actually binds; drop hairline round-off violations
          .sort(function (a, b) { return b.rel - a.rel; })
          .filter(function (e, i) { return i === 0 || e.rel > 0.01; })
          .slice(0, 3);
      }
      // per point: feasibility, each objective's value, each varied
      // parameter's value — everything scoring and the scatters need
      points.push({
        ok: ok,
        objVals: cfg.objectives.map(function (o) { return valueOf(sample, r, o.key); }),
        vals: cfg.varied.map(function (vp) { return sample[vp.key]; })
      });
    }

    // weighted scoring: min-max normalize each objective over the feasible
    // set, flip minimized objectives, then take the weighted average
    var lo = [], hi = [];
    cfg.objectives.forEach(function (o, oi) { lo[oi] = Infinity; hi[oi] = -Infinity; });
    points.forEach(function (p) {
      if (!p.ok) return;
      p.objVals.forEach(function (v, oi) {
        if (!isFinite(v)) return;
        if (v < lo[oi]) lo[oi] = v;
        if (v > hi[oi]) hi[oi] = v;
      });
    });
    var wsum = cfg.objectives.reduce(function (a, o) { return a + o.weight; }, 0) || 1;
    function scoreOf(p) {
      var s = 0;
      cfg.objectives.forEach(function (o, oi) {
        var v = p.objVals[oi], n;
        if (!isFinite(v)) n = 0;
        else if (!(hi[oi] > lo[oi])) n = 0.5;
        else n = Math.min(1, Math.max(0, (v - lo[oi]) / (hi[oi] - lo[oi])));
        if (o.dir === 'min') n = 1 - n;
        s += o.weight * n;
      });
      return s / wsum;
    }
    var best = null;
    points.forEach(function (p, i) {
      p.score = scoreOf(p);
      if (p.ok && (!best || p.score > best.score)) best = { score: p.score, index: i };
    });
    if (best) {
      var bp = points[best.index];
      bp.best = true;
      var params = {};
      PARAMS.forEach(function (p) { params[p.key] = base[p.key]; });
      cfg.varied.forEach(function (vp, vi) { params[vp.key] = bp.vals[vi]; });
      best.params = params;
      best.derived = derive(params);
      best.objVals = bp.objVals;
    }
    var ms = performance.now() - t0;
    mcResult = { cfg: cfg, points: points, best: best, feasible: feasible, ms: ms, base: base, nearMiss: nearMiss };
    renderMcResults();
  }

  function nearMissText(nearMiss) {
    if (!nearMiss || !nearMiss.length) return '';
    return nearMiss.map(function (v) {
      return labelFor(v.key) + ' ' + fmtMetric(v.key, v.value) +
        (v.side === 'min' ? ' < ' : ' > ') + fmtMetric(v.key, v.bound);
    }).join(', ');
  }

  function objectiveSummary(cfg, best) {
    return cfg.objectives.map(function (o, oi) {
      var m = metricByKey[o.key], u = m ? m.unit : (paramByKey[o.key] ? paramByKey[o.key].unit : '');
      return labelFor(o.key) + ' ' + fmtMetric(o.key, best.objVals[oi]) + (u && u !== '-' ? ' ' + u : '');
    }).join(' · ');
  }

  function renderMcResults() {
    var res = mcResult;
    var statusEl = document.getElementById('uav-mc-status');
    var cfg = res.cfg;
    var bestText = '';
    if (res.best) {
      bestText = cfg.objectives.length > 1
        ? ' · best weighted score ' + fmt(res.best.score, 3) + ' — ' + objectiveSummary(cfg, res.best)
        : ' · best ' + objectiveSummary(cfg, res.best);
    } else {
      var nm = nearMissText(res.nearMiss);
      bestText = ' · no feasible sample — ' + (nm ? 'closest miss: ' + nm : 'relax constraints or widen ranges');
    }
    statusEl.textContent = res.points.length + ' samples in ' + fmt(res.ms, 0) + ' ms · ' +
      res.feasible + ' feasible (' + fmt(100 * res.feasible / res.points.length, 1) + ' %)' + bestText;
    renderMcScatters();
    renderDesignReview(res);
  }

  /* ── design review slide for the best feasible sample ────────────────── */
  function reviewTile(label, value, unit, sub) {
    return '<div class="tools-readout">' +
      '<span class="tools-readout-label">' + esc(label) + '</span>' +
      '<span class="tools-readout-value mono">' + value +
      (unit ? '<span class="uav-unit"> ' + esc(unit) + '</span>' : '') + '</span>' +
      '<span class="tools-readout-sub">' + sub + '</span></div>';
  }

  function renderDesignReview(res) {
    var bestHost = document.getElementById('uav-mc-best');
    if (!res.best) { bestHost.innerHTML = ''; return; }
    var cfg = res.cfg;
    var p = res.best.params;
    var r = res.best.derived;
    var baseName = document.getElementById('uav-design-name').value.trim() || 'unnamed-uav';
    var reviewName = baseName + '-mc-best';

    // headline + configuration spec line
    var multi = cfg.objectives.length > 1;
    var headline = multi
      ? 'weighted score ' + fmt(res.best.score, 3) + ' — ' + objectiveSummary(cfg, res.best)
      : (cfg.objectives[0].dir === 'max' ? 'maximized ' : 'minimized ') + objectiveSummary(cfg, res.best);
    var html = '<div class="uav-review">';
    html += '<div class="uav-review-header"><span>DESIGN REVIEW &mdash; ' + esc(reviewName) + '</span>' +
      '<span>' + esc(headline) + '</span></div>';
    html += '<div class="uav-review-config">' +
      fmt(p.span, 2) + ' m span &middot; ' + esc(TAIL_TYPES[p.tailType].label.toLowerCase()) + ' tail &middot; ' +
      esc(r.foil.label) + ' wing &middot; ' + fmtInt(r.massTotal) + ' g AUW (' + fmtInt(p.payload) + ' g payload) &middot; ' +
      p.battCells + 'S ' + fmtInt(p.battCapacity) + ' mAh &middot; ' + fmtInt(p.maxPower) + ' W &middot; ' +
      fmt(p.propDiameter, 0) + ' in prop &middot; cruise ' + fmt(p.cruiseSpeed, 1) + ' m/s</div>';
    html += '<div class="uav-review-note">Best feasible sample of ' + res.feasible + ' feasible / ' +
      res.points.length + ' evaluated. All figures recomputed from the sampled parameters with the model on this page.</div>';

    // objective breakdown (weighted runs)
    if (multi) {
      var wsum = cfg.objectives.reduce(function (a, o) { return a + o.weight; }, 0) || 1;
      html += '<div class="uav-review-sub">Objective breakdown</div>';
      html += '<div class="table-scroll"><table class="tools-ref-table uav-review-table"><thead><tr>' +
        '<th>Objective</th><th>Direction</th><th class="num">Weight</th><th class="num">Best sample</th></tr></thead><tbody>';
      cfg.objectives.forEach(function (o, oi) {
        var m = metricByKey[o.key], u = m ? m.unit : (paramByKey[o.key] ? paramByKey[o.key].unit : '');
        html += '<tr><td>' + esc(labelFor(o.key)) + '</td>' +
          '<td>' + (o.dir === 'max' ? 'maximize' : 'minimize') + '</td>' +
          '<td class="num">' + fmt(o.weight, 2) + ' (' + fmt(100 * o.weight / wsum, 0) + ' %)</td>' +
          '<td class="num">' + fmtMetric(o.key, res.best.objVals[oi]) + (u && u !== '-' ? ' ' + esc(u) : '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // key figures
    html += '<div class="uav-review-sub">Key figures</div>';
    html += '<div class="tools-result-grid cols-3">';
    html += reviewTile('All-up mass', fmtInt(r.massTotal), 'g', 'battery ' + fmtInt(r.battMass) + ' g · ' + fmt(r.battWh, 1) + ' Wh');
    html += reviewTile('Wing loading', fmt(r.wingLoading, 1), 'g/dm²', fmt(r.massTotal / 1000 / r.S, 2) + ' kg/m² · area ' + fmt(r.area, 1) + ' dm²');
    html += reviewTile('Geometry', fmt(p.span, 2), 'm span', 'AR ' + fmt(r.aspectRatio, 2) + ' · length ' + fmt(r.totalLength, 2) + ' m');
    html += reviewTile('Stall speed', fmt(r.vstall, 1), 'm/s', 'cruise/stall ' + fmt(r.stallMargin, 2) + ' · CL max ' + fmt(r.clMax3D, 2));
    html += reviewTile('L/D', fmt(r.ldCruise, 1), 'cruise', 'max ' + fmt(r.ldMax, 1) + ' at ' + fmt(r.vLdMax, 1) + ' m/s');
    html += reviewTile('Cruise power', fmt(r.cruisePowerE, 1), 'W', fmt(r.throttle, 0) + ' % throttle · ' + fmt(r.current, 1) + ' A · ' + fmt(r.cRate, 1) + ' C');
    html += reviewTile('Endurance', fmtInt(r.endurance), 'min', 'range ' + fmt(r.range, 1) + ' km still air');
    html += reviewTile('Climb', fmt(r.roc, 1), 'm/s', 'T/W ' + fmt(r.thrustWeight, 2) + ' · static thrust ' + fmtInt(r.staticThrust) + ' g');
    html += reviewTile('Static margin', fmt(r.staticMargin, 1), '% MAC', 'NP ' + fmt(r.npMac, 1) + ' % · CG ' + fmt(p.cgMac, 1) + ' %');
    html += '</div>';

    // suggested airframe views (filled in after insertion)
    html += '<div class="uav-review-sub">Suggested airframe</div>';
    html += '<div class="uav-views-grid uav-review-views">' +
      '<figure class="uav-fig"><div id="uav-review-top"></div><figcaption class="uav-fig-caption">top view &mdash; best sample, to scale</figcaption></figure>' +
      '<figure class="uav-fig"><div id="uav-review-side"></div><figcaption class="uav-fig-caption">side view &mdash; CG vs neutral point</figcaption></figure></div>';

    // mass budget
    var budget = [
      ['Structure', p.structure], ['Payload', p.payload], ['Avionics + servos', p.avionics],
      ['Propulsion group', p.propMass], ['Battery pack', r.battMass]
    ];
    html += '<div class="uav-review-sub">Mass budget</div>';
    html += '<div class="table-scroll"><table class="tools-ref-table uav-review-table"><thead><tr>' +
      '<th>Item</th><th class="num">Mass (g)</th><th class="num">Share of AUW</th></tr></thead><tbody>';
    budget.forEach(function (row) {
      html += '<tr><td>' + row[0] + '</td><td class="num">' + fmtInt(row[1]) + '</td>' +
        '<td class="num">' + fmt(100 * row[1] / r.massTotal, 1) + ' %</td></tr>';
    });
    html += '<tr class="uav-review-total"><td>All-up mass</td><td class="num">' + fmtInt(r.massTotal) + '</td><td class="num">100.0 %</td></tr>';
    html += '</tbody></table></div>';

    // design checks on the best sample
    html += '<div class="uav-review-sub">Design checks (best sample)</div>';
    html += '<div class="table-scroll"><table class="tools-ref-table uav-check-table"><thead><tr>' +
      '<th>Check</th><th class="num">Value</th><th>Guideline</th><th>Status</th></tr></thead><tbody>' +
      checksRowsHtml(p, r) + '</tbody></table></div>';

    // constraint verification with margins
    if (cfg.constraints.length) {
      html += '<div class="uav-review-sub">Constraint verification</div>';
      html += '<div class="table-scroll"><table class="tools-ref-table uav-review-table"><thead><tr>' +
        '<th>Constraint</th><th class="num">Bound</th><th class="num">Best sample</th><th class="num">Margin</th></tr></thead><tbody>';
      cfg.constraints.forEach(function (c) {
        var v = valueOf(p, r, c.key);
        var bounds = [];
        if (isFinite(c.min)) bounds.push('&ge; ' + fmtMetric(c.key, c.min));
        if (isFinite(c.max)) bounds.push('&le; ' + fmtMetric(c.key, c.max));
        var margin = Math.min(
          isFinite(c.min) ? v - c.min : Infinity,
          isFinite(c.max) ? c.max - v : Infinity);
        html += '<tr><td>' + esc(labelFor(c.key)) + '</td>' +
          '<td class="num">' + bounds.join(' &middot; ') + '</td>' +
          '<td class="num">' + fmtMetric(c.key, v) + '</td>' +
          '<td class="num">' + (margin === Infinity ? DASH : fmtMetric(c.key, margin)) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // varied parameters vs current working design
    html += '<div class="uav-review-sub">Suggested parameter changes</div>';
    html += '<div class="table-scroll"><table class="tools-ref-table uav-review-table"><thead><tr>' +
      '<th>Varied parameter</th><th class="num">Current</th><th class="num">Suggested</th><th class="num">&Delta;</th></tr></thead><tbody>';
    cfg.varied.forEach(function (vp) {
      var pd = paramByKey[vp.key];
      var cur = design[vp.key], sug = p[vp.key];
      var delta = cur !== 0 ? 100 * (sug - cur) / Math.abs(cur) : NaN;
      html += '<tr><td>' + esc(pd.label) + ' (' + esc(pd.unit) + ')</td>' +
        '<td class="num">' + fmt(cur, decimalsOf(pd.step)) + '</td>' +
        '<td class="num">' + fmt(sug, decimalsOf(pd.step)) + '</td>' +
        '<td class="num">' + (isFinite(delta) ? (delta >= 0 ? '+' : '') + fmt(delta, 1) + ' %' : DASH) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // actions + provenance footer
    html += '<div class="tools-controls uav-review-actions">' +
      '<button type="button" class="tools-button primary" id="uav-mc-apply">Apply to working design</button>' +
      '<button type="button" class="tools-button" id="uav-mc-save-best">Save reviewed design &darr;</button>' +
      '<span class="tools-controls-spacer"></span></div>';
    html += '<div class="uav-review-footer">Generated ' + new Date().toISOString() +
      ' &middot; schema ' + SCHEMA + ' &middot; conceptual-design fidelity &mdash; see model notes below.</div>';
    html += '</div>';

    bestHost.innerHTML = html;
    renderTopView(p, r, 'uav-review-top');
    renderSideView(p, r, 'uav-review-side');

    document.getElementById('uav-mc-apply').addEventListener('click', function () {
      cfg.varied.forEach(function (vp) {
        design[vp.key] = res.best.params[vp.key];
        notePresetDivergence(vp.key);
      });
      designTouched = true;
      syncForm();
      recompute();
      setFileStatus('Applied Monte Carlo best sample to the working design.');
    });
    document.getElementById('uav-mc-save-best').addEventListener('click', function () {
      var saved = downloadDesignFile(designFileFrom(res.best.params, reviewName));
      setFileStatus('Saved reviewed design ' + saved + ' (working design unchanged).');
    });
  }

  function labelFor(key) {
    if (metricByKey[key]) return metricByKey[key].label;
    if (paramByKey[key]) return paramByKey[key].label;
    return key;
  }

  /* Scatters, auto-generated per run. With one objective: one plot per varied
   * parameter, objective on X. With several: objective-vs-objective knee-curve
   * plots first, then per-parameter plots against the weighted score. */
  function objAxisLabel(cfg, oi) {
    var o = cfg.objectives[oi];
    var m = metricByKey[o.key], u = m ? m.unit : (paramByKey[o.key] ? paramByKey[o.key].unit : '');
    return labelFor(o.key) + (u && u !== '-' ? ' (' + u + ')' : '');
  }

  function renderMcScatters() {
    var res = mcResult;
    var host = document.getElementById('uav-mc-scatters');
    if (!res || !res.cfg.varied.length) { host.innerHTML = ''; return; }
    var cfg = res.cfg;
    var multi = cfg.objectives.length > 1;
    var W = 640, H = 300, M = { l: 64, r: 16, t: 14, b: 46 };
    var figN = 0;
    var html = '';

    // per-plot draw budget scales down as plot count grows so a vary-everything
    // run stays responsive (every sample is still evaluated; plots are thinned)
    var nPlots = cfg.varied.length + (multi ? cfg.objectives.length * (cfg.objectives.length - 1) / 2 : 0);
    var MAX_DRAW = Math.max(400, Math.floor(12000 / Math.max(1, nPlots)));

    function drawSet(getX, getY, wantOk, radius, cls, fr) {
      var s = '', idx = [];
      res.points.forEach(function (p, i) {
        if (p.ok === wantOk && isFinite(getX(p)) && isFinite(getY(p))) idx.push(i);
      });
      var stride = Math.max(1, Math.ceil(idx.length / MAX_DRAW));
      for (var i = 0; i < idx.length; i += stride) {
        var p = res.points[idx[i]];
        s += '<circle cx="' + f2(fr.X(getX(p))) + '" cy="' + f2(fr.Y(getY(p))) + '" r="' + radius + '" class="' + cls + '"/>';
      }
      return s;
    }

    function bestMark(getX, getY, fr) {
      if (!res.best) return '';
      var b = res.points[res.best.index];
      if (!isFinite(getX(b)) || !isFinite(getY(b))) return '';
      var bx = fr.X(getX(b)), by = fr.Y(getY(b));
      // halo under ring under guaranteed center dot: stays legible when the
      // viewBox scales down to phone width and the cloud is dense (the best
      // point itself may have been stride-thinned out, so redraw it)
      var s = '<circle cx="' + f2(bx) + '" cy="' + f2(by) + '" r="9" class="uav-pt-best-halo"/>';
      s += '<circle cx="' + f2(bx) + '" cy="' + f2(by) + '" r="9" class="uav-pt-best"/>';
      s += '<circle cx="' + f2(bx) + '" cy="' + f2(by) + '" r="3.5" class="uav-pt-best-core"/>';
      // the best sample often sits at an extreme — flip the label inboard
      s += bx > W - 64 ? text(bx - 13, by + 4, 'BEST', 'uav-best-label', 'end')
                       : text(bx + 13, by + 4, 'BEST', 'uav-best-label');
      return s;
    }

    function rangeOf(get) {
      var lo = Infinity, hi = -Infinity;
      res.points.forEach(function (p) {
        var v = get(p);
        if (!isFinite(v)) return;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
      if (lo === Infinity) return null;
      if (lo === hi) { lo -= 1; hi += 1; }
      return [lo, hi];
    }

    function plot(getX, getY, xlab, ylab, ymin, ymax, caption) {
      var xr = rangeOf(getX);
      if (!xr) return;
      figN++;
      var fr = chartFrame(W, H, M, xr[0], xr[1], ymin, ymax, xlab, ylab);
      var s = svgOpen(W, H) + '<title>' + esc(ylab) + ' vs ' + esc(xlab) + '</title>' + fr.svg;
      s += drawSet(getX, getY, false, 2, 'uav-pt-infeasible', fr);
      s += drawSet(getX, getY, true, 2.5, 'uav-pt-feasible', fr);
      s += bestMark(getX, getY, fr);
      s += '</svg>';
      html += '<figure class="uav-fig"><div>' + s + '</div>' +
        '<figcaption class="uav-fig-caption">FIG 8.' + figN + ' &mdash; ' + caption + '</figcaption></figure>';
    }

    // knee curves: every objective pair, raw units — the feasible frontier is
    // the trade the weights are choosing a point on
    if (multi) {
      for (var oi = 0; oi < cfg.objectives.length; oi++) {
        for (var oj = oi + 1; oj < cfg.objectives.length; oj++) {
          (function (oi, oj) {
            var yr = rangeOf(function (p) { return p.objVals[oj]; });
            if (!yr) return;
            plot(function (p) { return p.objVals[oi]; },
                 function (p) { return p.objVals[oj]; },
                 objAxisLabel(cfg, oi), objAxisLabel(cfg, oj), yr[0], yr[1],
                 esc(labelFor(cfg.objectives[oj].key)) + ' vs ' + esc(labelFor(cfg.objectives[oi].key)) +
                 ' &mdash; the attainable trade; the ringed sample is where the weights landed.');
          }(oi, oj));
        }
      }
    }

    // one plot per varied parameter
    var getX = multi ? function (p) { return p.score; } : function (p) { return p.objVals[0]; };
    var xlab = multi ? 'weighted score (0–1)' : objAxisLabel(cfg, 0);
    cfg.varied.forEach(function (vp, vi) {
      var pd = paramByKey[vp.key];
      var ymin = vp.min, ymax = vp.max;
      if (ymin === ymax) { ymin -= 1; ymax += 1; }
      plot(getX, function (p) { return p.vals[vi]; }, xlab, pd.label, ymin, ymax,
        esc(pd.label) + ' (' + esc(pd.unit) + ') vs ' + (multi ? 'weighted score' : esc(labelFor(cfg.objectives[0].key))) +
        ', sampled ' + fmt(vp.min, decimalsOf(pd.step)) + '&ndash;' + fmt(vp.max, decimalsOf(pd.step)) + '.');
    });
    host.innerHTML = html;
  }

  /* ── mission solver ──────────────────────────────────────────────────
   * Describe the job; the solver sizes a starting point from scaling
   * heuristics, programs the Monte Carlo UI (visible — every choice can be
   * inspected and edited), runs a two-stage search per candidate
   * configuration, compares configurations, and applies the winner.
   */
  // auwMax: what the launch method can physically throw — a stall cap alone
  // would happily "hand launch" an 18 kg aircraft
  var LAUNCH_TYPES = {
    hand:     { label: 'hand launch',     stallMax: 8,        twMin: 0.55, wl: 35, auwMax: 2500 },
    catapult: { label: 'catapult/bungee', stallMax: 12,       twMin: 0.60, wl: 55, auwMax: 15000 },
    runway:   { label: 'runway / belly',  stallMax: 20,       twMin: 0.35, wl: 85, auwMax: 0 },
    any:      { label: 'any launch',      stallMax: Infinity, twMin: 0.35, wl: 60, auwMax: 0 }
  };

  var MISSION_OBJECTIVES = {
    lightest:  { key: 'massTotal', dir: 'min', label: 'lightest aircraft that flies the mission' },
    endurance: { key: 'endurance', dir: 'max', label: 'longest endurance' },
    range:     { key: 'range',     dir: 'max', label: 'longest still-air range' },
    smallest:  { key: 'span',      dir: 'min', label: 'smallest span that flies the mission' }
  };

  function pickMotorPreset(powerW) {
    var items = PRESETS.motor.items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].specs.maxPower >= powerW) return items[i];
    }
    return items[items.length - 1];
  }

  function missionBaseDesign(m, config) {
    var fw = config === 'flyingwing';
    var auw = Math.max(m.payload / 0.28, m.payload + 300);       // g — payload-fraction guess
    var wl = LAUNCH_TYPES[m.launch].wl * (fw ? 0.85 : 1);        // g/dm^2
    var S = auw / wl / 100;                                       // m^2
    var ar = fw ? 5 : 7.5;
    var taper = fw ? 0.45 : 0.65;
    var span = Math.sqrt(ar * S);
    if (m.maxSpan && span > m.maxSpan) span = m.maxSpan;          // honor the cage; chord grows instead
    var rootChord = 2 * S / (span * (1 + taper));
    var weightN = auw / 1000 * G;
    var vs = Math.sqrt(2 * weightN / (1.225 * S * (fw ? 0.85 : 1.1)));
    var cruise = Math.max(m.minCruise || 0, 1.5 * vs);
    var pElec = weightN * cruise / ((fw ? 10 : 9) * 0.47);        // L/D and efficiency-chain guess
    var powerNeed = Math.max(pElec * 3.5, auw * (LAUNCH_TYPES[m.launch].twMin + 0.15));
    var motor = pickMotorPreset(powerNeed);
    var cells = motor.specs.battCells;
    var density = m.endurance > 90 ? 240 : 150;                   // Li-ion for long loiter
    var capacity = (m.endurance / 60) * pElec / (cells * CELL_V) / 0.8 * 1000;
    var d = {
      span: span, rootChord: rootChord, taper: taper,
      sweepLE: fw ? 25 : 0,
      dihedral: fw ? 0 : 4,
      fusLength: fw ? Math.max(0.25, 1.4 * rootChord) : Math.max(0.4, 0.62 * span),
      fusDiameter: Math.max(0.05, 0.075 * Math.pow(auw / 1000, 1 / 3) + 0.03),
      cgMac: fw ? 19 : 30,
      tailType: fw ? 'flyingwing' : 'conventional',
      tailArm: Math.max(0.2, 0.4 * span),
      vh: 0.5, vv: 0.035, arH: 4, arV: 1.5, tailTaper: 0.7,
      airfoil: fw ? 'mh60' : (m.objective === 'lightest' ? 'clarky' : 'sd7037'),
      oswald: fw ? 0.75 : 0.8,
      structure: Math.round((fw ? 0.28 : 0.32) * auw),
      payload: m.payload,
      avionics: Math.round(60 + auw * 0.01),
      propMass: motor.specs.propMass,
      battCapacity: Math.round(capacity / 50) * 50,
      battCells: cells,
      battDensity: density,
      usableBatt: 0.8,
      maxPower: motor.specs.maxPower,
      propDiameter: motor.specs.propDiameter,
      etaProp: 0.55, etaMotor: 0.85,
      cruiseSpeed: Math.round(cruise * 2) / 2,
      altitude: design.altitude // keep the operator's field altitude
    };
    PARAMS.forEach(function (p) {
      if (p.options || d[p.key] === undefined) return;
      d[p.key] = Math.min(p.max, Math.max(p.min, d[p.key]));
    });
    return d;
  }

  function missionVarySet(m, base, config) {
    var fw = config === 'flyingwing';
    var keys = ['span', 'rootChord', 'taper', 'fusLength', 'fusDiameter',
                'battCapacity', 'maxPower', 'propDiameter', 'cruiseSpeed'];
    if (fw) keys.push('sweepLE'); else keys.push('dihedral', 'tailArm', 'vh');
    var list = keys.map(function (k) {
      var p = paramByKey[k], v = base[k];
      var lo = Math.max(p.min, v * 0.65), hi = Math.min(p.max, v * 1.4);
      if (k === 'sweepLE') { lo = 15; hi = 32; }
      if (k === 'span' && m.maxSpan) hi = Math.min(hi, m.maxSpan);
      if (k === 'cruiseSpeed' && m.minCruise) lo = Math.max(lo, m.minCruise);
      return { key: k, lo: lo, hi: hi };
    });
    list.push({ key: 'cgMac', lo: fw ? 15 : 24, hi: fw ? 24 : 36 });
    return list;
  }

  function missionConstraints(m, config) {
    var fw = config === 'flyingwing';
    var L = LAUNCH_TYPES[m.launch];
    var list = [
      { key: 'endurance', min: m.endurance, max: undefined },
      { key: 'thrustWeight', min: L.twMin, max: undefined },
      { key: 'staticMargin', min: fw ? 3 : 4, max: fw ? 8 : 18 },
      { key: 'throttle', min: undefined, max: 80 },
      { key: 'cRate', min: undefined, max: 25 }
    ];
    if (isFinite(L.stallMax)) list.push({ key: 'vstall', min: undefined, max: L.stallMax });
    if (L.auwMax) list.push({ key: 'massTotal', min: undefined, max: L.auwMax });
    if (m.maxSpan) list.push({ key: 'span', min: undefined, max: m.maxSpan });
    if (m.minCruise) list.push({ key: 'cruiseSpeed', min: m.minCruise, max: undefined });
    return list;
  }

  function setVaryRange(key, lo, hi) {
    var p = paramByKey[key];
    lo = Math.max(p.min, lo);
    hi = Math.min(p.max, Math.max(lo, hi));
    document.querySelector('[data-mc-min="' + key + '"]').value = +lo.toFixed(Math.max(4, decimalsOf(p.step)));
    document.querySelector('[data-mc-max="' + key + '"]').value = +hi.toFixed(Math.max(4, decimalsOf(p.step)));
  }

  function setMcUi(varied, constraints, objective, samples) {
    document.querySelectorAll('[data-mc-vary]').forEach(function (cb) {
      cb.checked = false;
      delete cb.dataset.wasChecked;
    });
    varied.forEach(function (v) {
      var cb = document.querySelector('[data-mc-vary="' + v.key + '"]');
      if (cb && !cb.disabled) cb.checked = true;
      setVaryRange(v.key, v.lo !== undefined ? v.lo : v.min, v.hi !== undefined ? v.hi : v.max);
    });
    document.getElementById('uav-mc-constraints-body').innerHTML = '';
    constraints.forEach(function (c) {
      addConstraintRow(c.key,
        (c.min !== undefined && isFinite(c.min)) ? +(+c.min).toFixed(4) : undefined,
        (c.max !== undefined && isFinite(c.max)) ? +(+c.max).toFixed(4) : undefined);
    });
    document.getElementById('uav-mc-objectives-body').innerHTML = '';
    (Array.isArray(objective) ? objective : [objective]).forEach(function (o) {
      addObjectiveRow(o.key, o.dir, o.weight || 1);
    });
    document.getElementById('uav-mc-samples').value = samples || 6000;
  }

  function objBetter(dir, a, b) {
    return dir === 'max' ? a > b : a < b;
  }

  // two-stage search: wide, then re-centered around the stage-1 best;
  // a failed wide stage gets one automatic range widening before giving up
  function stagedSearch() {
    runMonteCarlo();
    if (!mcResult.best) {
      mcResult.cfg.varied.forEach(function (vp) {
        var c = (vp.min + vp.max) / 2, w = vp.max - vp.min;
        setVaryRange(vp.key, c - w, c + w);
      });
      runMonteCarlo();
      if (!mcResult.best) return mcResult;
    }
    var s1 = mcResult;
    s1.cfg.varied.forEach(function (vp) {
      var b = s1.best.params[vp.key];
      var w = (vp.max - vp.min) * 0.18;
      setVaryRange(vp.key, b - w, b + w);
    });
    runMonteCarlo();
    var dir = s1.cfg.objectives[0].dir;
    if (!mcResult.best || objBetter(dir, s1.best.objVals[0], mcResult.best.objVals[0])) {
      // zoom stage lost (rare) — restore the stage-1 ranges and result
      s1.cfg.varied.forEach(function (vp) { setVaryRange(vp.key, vp.min, vp.max); });
      mcResult = s1;
      renderMcResults();
    }
    return mcResult;
  }

  function solveConfigCandidate(m, config) {
    var base = missionBaseDesign(m, config);
    PARAMS.forEach(function (p) {
      if (base[p.key] !== undefined) design[p.key] = base[p.key];
    });
    designTouched = true;
    syncForm();
    recompute(); // updates relevance so flying-wing tail rows are excluded
    var obj = MISSION_OBJECTIVES[m.objective];
    setMcUi(missionVarySet(m, base, config), missionConstraints(m, config), obj, 6000);
    var res = stagedSearch();
    return {
      config: config,
      res: res,
      ok: !!res.best,
      objValue: res.best ? res.best.objVals[0] : NaN,
      nearMiss: res.nearMiss
    };
  }

  function candidateSummary(c, m) {
    var lbl = TAIL_TYPES[c.config === 'flyingwing' ? 'flyingwing' : 'conventional'].label.toLowerCase();
    if (!c.ok) return lbl + ': no feasible design (closest miss: ' + (nearMissText(c.nearMiss) || 'n/a') + ')';
    var r = c.res.best.derived;
    var mu = metricByKey[m.objectiveKey], unit = mu ? mu.unit : (paramByKey[m.objectiveKey] ? paramByKey[m.objectiveKey].unit : '');
    return lbl + ': ' + fmt(c.res.best.params.span, 2) + ' m span · ' + fmtInt(r.massTotal) + ' g AUW · ' +
      fmtInt(r.endurance) + ' min · stall ' + fmt(r.vstall, 1) + ' m/s · ' +
      labelFor(m.objectiveKey) + ' ' + fmtMetric(m.objectiveKey, c.objValue) + (unit && unit !== '-' ? ' ' + unit : '');
  }

  function solveMission() {
    var statusEl = document.getElementById('uav-mission-status');
    var m = {
      payload: parseFloat(document.getElementById('uav-mission-payload').value),
      endurance: parseFloat(document.getElementById('uav-mission-endurance').value),
      launch: document.getElementById('uav-mission-launch').value,
      config: document.getElementById('uav-mission-config').value,
      objective: document.getElementById('uav-mission-objective').value,
      maxSpan: parseFloat(document.getElementById('uav-mission-maxspan').value) || 0,
      minCruise: parseFloat(document.getElementById('uav-mission-mincruise').value) || 0
    };
    if (!isFinite(m.payload) || m.payload < 0) { statusEl.textContent = 'Enter a payload mass (0 is allowed).'; return; }
    if (!isFinite(m.endurance) || m.endurance <= 0) { statusEl.textContent = 'Enter an endurance target in minutes.'; return; }
    m.objectiveKey = MISSION_OBJECTIVES[m.objective].key;

    var candidates = m.config === 'both' ? ['conventional', 'flyingwing'] : [m.config];
    var results = candidates.map(function (cfg) { return solveConfigCandidate(m, cfg); });

    var feasibleResults = results.filter(function (c) { return c.ok; });
    var lines = ['MISSION: ' + fmtInt(m.payload) + ' g payload · ≥ ' + fmt(m.endurance, 0) + ' min · ' +
      LAUNCH_TYPES[m.launch].label + ' · objective: ' + MISSION_OBJECTIVES[m.objective].label +
      (m.maxSpan ? ' · span ≤ ' + m.maxSpan + ' m' : '') + (m.minCruise ? ' · cruise ≥ ' + m.minCruise + ' m/s' : '')];
    results.forEach(function (c) { lines.push(candidateSummary(c, m)); });

    if (!feasibleResults.length) {
      lines.push('No feasible design inside the parameter bounds. The closest misses above show which requirement binds — relax it, change the launch method, or shrink the payload, then solve again.');
      statusEl.textContent = lines.join('\n');
      return;
    }

    var dir = MISSION_OBJECTIVES[m.objective].dir;
    var winner = feasibleResults[0];
    feasibleResults.forEach(function (c) {
      if (objBetter(dir, c.objValue, winner.objValue)) winner = c;
    });

    // adopt the winner's design first (so parameter relevance matches its
    // configuration), then restore its search setup and result
    PARAMS.forEach(function (p) { design[p.key] = winner.res.best.params[p.key]; });
    designTouched = true;
    syncForm();
    recompute();
    setMcUi(winner.res.cfg.varied.map(function (vp) { return { key: vp.key, lo: vp.min, hi: vp.max }; }),
      winner.res.cfg.constraints, winner.res.cfg.objectives, winner.res.cfg.samples);
    mcResult = winner.res;
    renderMcResults();

    if (results.length > 1) {
      lines.push('Chosen: ' + TAIL_TYPES[winner.config === 'flyingwing' ? 'flyingwing' : 'conventional'].label +
        ' — better ' + labelFor(m.objectiveKey) + ' for this brief.');
    }
    lines.push('Two-stage search (wide, then re-centered on the best) ran per configuration; the winning design has been applied to the working design and every solver choice is visible in the Monte Carlo controls below — tweak and re-run. Full design review at the bottom of the Monte Carlo section.');
    statusEl.textContent = lines.join('\n');
  }

  /* ── main recompute ──────────────────────────────────────────────────── */
  function recompute() {
    derived = derive(design);
    renderReadouts(derived);
    renderChecks(design, derived);
    renderTopView(design, derived);
    renderSideView(design, derived);
    renderFrontView(design, derived);
    renderAirfoil(design, derived);
    view3D.mesh = build3DMesh(design, derived);
    render3D();
    renderPowerChart(design, derived);
    renderPolarChart(design, derived);
    renderSensitivity(derived);
    syncMcCurrents();
    updateRelevance();
    autosave();
  }

  /* ── init ────────────────────────────────────────────────────────────── */
  function init() {
    buildForm();
    buildPresetTables();
    buildMcVaryTable();
    renderParamReference();
    setup3D();
    // default objective: maximize endurance, weight 1
    addObjectiveRow('endurance', 'max', 1);
    // prepopulated constraint set: airworthiness rows carry working bounds;
    // logistics/mission rows are blank templates — blank rows are ignored by
    // the solver until a bound is filled in
    addConstraintRow('staticMargin', 4, 20);
    addConstraintRow('thrustWeight', 0.5, undefined);
    addConstraintRow('massTotal');
    addConstraintRow('payload');
    addConstraintRow('span');
    addConstraintRow('totalLength');
    addConstraintRow('vstall');
    addConstraintRow('endurance');

    document.getElementById('uav-save').addEventListener('click', saveDesign);
    document.getElementById('uav-load-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadDesign(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('uav-reset').addEventListener('click', function () {
      design = defaultDesign();
      activePreset = { airframe: null, motor: null, battery: null };
      designTouched = false;
      clearAutosave();
      renderPresetStatus();
      syncForm();
      recompute();
      setFileStatus('Reset to default trainer-class design. Autosaved copy discarded.');
    });
    document.getElementById('uav-design-name').addEventListener('input', function () {
      designTouched = true;
      autosave();
    });
    document.getElementById('uav-mc-run').addEventListener('click', runMonteCarlo);
    document.getElementById('uav-mc-add-constraint').addEventListener('click', function () {
      addConstraintRow();
    });
    document.getElementById('uav-mc-add-objective').addEventListener('click', function () {
      addObjectiveRow('payload', 'max', 1);
    });
    document.getElementById('uav-mission-solve').addEventListener('click', solveMission);
    restoreAutosave();
    syncForm();
    recompute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
