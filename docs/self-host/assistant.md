---
title: "Set up the assistant"
summary: "Turn on the in-app assistant with an Anthropic or OpenAI key, and choose the models people may pick."
read_when:
  - "you want to turn on the assistant for your instance"
  - "you want to change which models people can choose"
audience:
  - operator
  - agent
checked: none
order: 4
---

The assistant runs on a key you bring from Anthropic or OpenAI. Each setting below is a variable, read when the server starts.

<!-- settings-assistant:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Anthropic credential** | `ANTHROPIC_API_KEY` |  | unset | An Anthropic API key | Enables the assistant with this provider. | By variable, after a restart |
| **OpenAI credential** | `OPENAI_API_KEY` |  | unset | An OpenAI API key | Enables the assistant with this provider. | By variable, after a restart |
| **Assistant provider** | `DEZFIL_AI_PROVIDER` |  | first key set | `anthropic` or `openai`; any other value leaves the assistant off | Selects the provider when more than one credential is present. | By variable, after a restart |
| **Assistant model** | `DEZFIL_AI_MODEL` |  | provider default | A model id the provider offers | Overrides the provider's default model. | By variable, after a restart |
| **Anthropic model offer** | `DEZFIL_AI_MODELS_ANTHROPIC` |  | unset | Model ids, separated by commas; set and empty, only the default | Narrows and orders the catalogue; a set empty list offers only the default. | By variable, after a restart |
| **OpenAI model offer** | `DEZFIL_AI_MODELS_OPENAI` |  | unset | Model ids, separated by commas; set and empty, only the default | Narrows and orders the catalogue; a set empty list offers only the default. | By variable, after a restart |
| **Assistant operation offer** | `DEZFIL_ASSISTANT_OFFER` |  | `subset` | `subset` or `full`; any other value reads as `subset` | Choose the page's subset or its full admitted operation set. | By variable, after a restart |
| **Automatic map check** | `DEZFIL_ASSISTANT_AUTO_CHECK` |  | on | `0`, `false` or `off` turns it off; any other value turns it on | Check the rendered map after an assistant turn changes it. | By variable, after a restart |
| **Assistant steps** | `DEZFIL_ASSISTANT_STEP_BUDGET` |  | `20` steps | Any number above 0 | Maximum model and tool steps per request. | By variable, after a restart |
| **Map check time limit** | `DEZFIL_ASSISTANT_LOOK_TIMEOUT_S` |  | `30` seconds | Any number above 0 | Budget for an assistant map check, including queue wait. | By variable, after a restart |
| **Retained map checks** | `DEZFIL_ASSISTANT_LOOK_RETENTION` |  | `256` images | Any number above 0, rounded down to a whole number of at least 1 | Full images and thumbnails retained in process. | By variable, after a restart |
| **Map check storage** | `DEZFIL_ASSISTANT_LOOK_RETENTION_MB` |  | `96` MB | Any number above 0 | Byte budget for retained map checks. | By variable, after a restart |

<!-- settings-assistant:end -->

The model lists narrow the optional model catalogue file in the data folder: see [the model catalogue file](backup-and-restore.md#the-model-catalogue-file).

[Configuration](configuration.md) shows how to set a variable.
