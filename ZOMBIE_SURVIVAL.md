# Lost Temple: Zombie Survival

The static Three.js game is hosted from the repository root and remains
deployable on GitHub Pages. Its browser title is **Treasure Hunt Game — Lost
Temple: Zombie Survival**. The centered credit **Created by Pishari Nakul** is
part of the shared page shell, so it stays on the home screen and gameplay HUD.

## Play

- **W/A/S/D**: move relative to the fixed third-person camera.
- **Shift**: sprint; **Space**: jump.
- **F** or **left mouse button**: swing the equipped sword.
- **E**: open a nearby chest; **I**: open the armory.
- **P**: pause; **Escape** or **H**: save a checkpoint and return home.
- On touchscreens, use the movement stick and on-screen attack, interact, sprint,
  and jump buttons.

Each level requires three relics, at least four gems, and every spawned zombie
defeated before the northern gate opens. Zombies pursue the explorer, attack at
melee range, and have visible health bars. Basic, runner, armored, and guardian
types are introduced progressively. Wood/Iron/Gold/Diamond swords and
Leather/Iron/Gold/Diamond armor unlock in order as the player advances; the
inventory shows their damage or damage-reduction statistics. H/Escape and
objective events save a restorable local checkpoint, or an account-scoped
checkpoint when Firebase is configured.

The level counter has no planned final stage. Seeded runs vary decor, collectibles,
enemy spawn order/count, and traps, while enemy health and damage scale as levels
rise. Enemy count is capped to protect browser performance.

## Account and security boundaries

Firebase Authentication and UID-scoped Firestore profile saves remain optional.
They require the setup described in `FIREBASE_SETUP.md`. Firestore rules validate
the profile shape and restrict reads/writes to the signed-in user's own document.
The game state is still produced by an untrusted browser client, so these rules do
not make scores, equipment, or progression authoritative or cheat-proof.

The repository is a static frontend and currently has **no trusted Firebase
Functions/backend, owner custom-claim provisioning, audit service, leaderboard,
or Administrator Dashboard**. In particular, the designated owner email is not
used as a frontend authorization check, and no admin control is exposed as a
decorative or insecure mock. Secure owner administration, server-validated
rewards, broader room-graph procedural generation/validation, puzzles, and
cross-device gameplay beyond the saved profile/checkpoint require additional
trusted backend work and configuration.

## Validation

Run `node --check game.js` for JavaScript syntax validation. Test the actual game
from a local HTTP server (ES modules and Three.js are not supported from
`file://`), then exercise movement, combat, objectives, checkpoint restore,
equipment unlocks, and responsive touch controls in a WebGL-capable browser.
Firebase sign-in/cloud tests require a configured Firebase project and enabled
OAuth providers; they are not simulated when configuration is absent.
