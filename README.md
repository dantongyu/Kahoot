# Quiz Game

A Kahoot-style live quiz game. The host runs the game on a big screen; players join
from their phones or any browser with a game PIN.

## Run

```
npm install
npm start
```

- Host screen: http://localhost:3000/host.html
- Players:     http://localhost:3000/player.html (or the LAN URL printed at startup)

## How a game works

1. Host picks a quiz → a 6-digit PIN is shown.
2. Players open the player page, enter the PIN and a nickname.
3. Host presses **Start**. Each question shows on the host screen with a countdown;
   players see only four colored answer buttons.
4. A question ends when the timer runs out or everyone has answered. The host screen
   shows the answer distribution, the correct answer, and the top-5 leaderboard;
   each player sees their own result, points, and rank.
5. After the last question the host screen shows the podium.

## Scoring

- Correct answer: `1000 × (1 − (responseTime / timeLimit) / 2)` → 1000 for an instant
  answer, 500 at the buzzer. Wrong or no answer: 0.
- Streak bonus: +100 per consecutive correct answer beyond the first, capped at +500.

## Adding quizzes

Drop a JSON file into `quizzes/`. It is picked up without restarting the server.

```json
{
  "title": "My Quiz",
  "questions": [
    {
      "text": "Question text?",
      "options": ["Red ▲", "Blue ◆", "Yellow ●", "Green ■"],
      "correct": 1,
      "timeLimit": 20
    }
  ]
}
```

- `options` must have exactly 4 entries (order = red, blue, yellow, green).
- `correct` is the 0-based index of the right option.
- `timeLimit` is in seconds (optional, default 20).

## Notes

- All state is in memory; restarting the server ends every game.
- Players who lose connection are re-joined automatically (same nickname) and keep
  their score. If the host closes their tab, the game ends for everyone.
# Kahoot
