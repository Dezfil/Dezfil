---
title: "Your AI key"
summary: "Add your own Anthropic or OpenAI key so the assistant answers you on it, then replace or remove it."
read_when:
  - "the assistant pane asks for an API key"
  - "you want the assistant to answer you on your own key, where the instance has one too"
  - "you want to replace or remove your key, or the note says it was rejected"
audience:
  - user
checked: none
order: 10
---

The assistant needs a key from Anthropic or OpenAI. Your own key answers whenever you have one. Otherwise the instance's does, if [whoever runs it](../self-host/assistant.md) set one.

- **You need:** an API key from your Anthropic or OpenAI account. The provider bills that account.

## Add your key

Where the instance has no key, the **Assistant** pane asks for yours. Where it has one, open **Settings** > **Assistant** and click **Add key**.

1. Under **Provider**, click **Anthropic** or **OpenAI**.
2. Paste your key under **API key**. **Save** shows.
3. Click **Save**. You should see the box **Ask the assistant…** in the pane, or **Saved** and the last four characters in **Settings**.

Saving does not try the key: your first message does.

Use a key with a spending limit, and revoke it at the provider if it leaks. Dezfil keeps it encrypted and never shows it again. No admin can read it or see that you have one.

Where the instance has a key too, the button under the box ends in **your key** or **instance key**, so you can see which pays.

## Replace or remove it

Open **Settings** > **Assistant**.

- **Replace** opens the same form. The saved key stays until you save another, and your requests in progress then stop.
- **Remove** asks first, and says what follows: the assistant uses the instance's key for you, or stops answering you until you add another. Your requests in progress stop.

An admin's **Reset password** or **New sign-in link** removes your key too, so whoever signs in next cannot spend it. Add it again once you are back in.

Scripts and agents use the same operations: `set_assistant_key` and `remove_assistant_key` in [Connect an AI agent](../api/mcp.md#permissions). The assistant inside the app cannot read or change your key.

## Troubleshooting

### The pane says "Add your own API key to use the assistant."

Neither you nor the instance has a key. Follow [Add your key](#add-your-key).

### The pane says it cannot read your saved API key

The instance's encryption key changed. Paste your key again and click **Save**.

### A note says "Your Anthropic key was rejected."

The provider refused it. Click **Replace key** in the note, paste a new one and click **Save**. **Technical detail** holds the provider's words.

### A note says "The instance's Anthropic key was rejected. An admin must replace it."

Tell whoever runs the instance, or add your own key.

### A note says "Your API key changed since this turn began. Send a new message."

You replaced or removed the key while a request was running or waited for you, so it ended. Send the message again.

## Next steps

- [The assistant](assistant.md): what to ask it, on each page.
- [Your settings](settings.md): the other things you set for yourself.
