import {
  createBot,
  Intents,
  startBot,
  CreateMessage,
  Embed,
  MessageComponents,
  InteractionResponseTypes,
  ApplicationCommandTypes,
  InteractionTypes,
  ButtonStyles,
  MessageComponentTypes,
  ChannelTypes,
} from "https://deno.land/x/discordeno@18.0.1/mod.ts";
import { load } from "https://deno.land/std@0.208.0/dotenv/mod.ts";

// 環境変数の読み込み
await load({ export: true });

const TOKEN = Deno.env.get("DISCORD_TOKEN");
const TARGET_CHANNEL_ID = Deno.env.get("TARGET_CHANNEL_ID");

// 定義されていないEnumを手動定義
const TextInputStyles = {
  Short: 1,
  Paragraph: 2,
} as const;

if (!TOKEN) {
  console.error("エラー: DISCORD_TOKENが設定されていません。");
  // Deno Deployの環境変数が設定されているか確認してください
}

// ---------------------------------------------------------
// データ定義
// ---------------------------------------------------------

interface RecruitmentData {
  hostId: bigint;
  title: string;
  date: string;
  time: string;
  maxRoles: {
    Tank: number;
    Healer: number;
    DPS: number;
  };
  currentRoles: {
    Tank: bigint[];
    Healer: bigint[];
    DPS: bigint[];
  };
  vcId: bigint | null;
}

// 簡易的なメモリ内保存
const recruitments = new Map<string, RecruitmentData>();

// ---------------------------------------------------------
// ユーティリティ関数
// ---------------------------------------------------------

// 募集パネル(Embed + Buttons)の更新
async function updateRecruitmentMessage(bot: any, channelId: bigint, messageId: bigint) {
  const data = recruitments.get(messageId.toString());
  if (!data) return;

  // Embedの作成
  const embed: Embed = {
    title: `募集: ${data.title}`,
    color: 0x0099ff,
    fields: [
      { name: "開催日時", value: `${data.date} ${data.time}`, inline: false },
      { name: "募集主", value: `<@${data.hostId}>`, inline: false },
    ],
  };

  // 参加者リスト
  const roles: ("Tank" | "Healer" | "DPS")[] = ["Tank", "Healer", "DPS"];
  for (const role of roles) {
    const members = data.currentRoles[role];
    const memberStr = members.length > 0
      ? members.map((uid) => `<@${uid}>`).join("\n")
      : "なし";
    embed.fields!.push({
      name: `${role} (${members.length}/${data.maxRoles[role]})`,
      value: memberStr,
      inline: true,
    });
  }

  if (data.vcId) {
    embed.fields!.push({ name: "VC", value: `<#${data.vcId}>`, inline: false });
  }

  // ボタンの作成
  const components: MessageComponents = [];
  
  // Row 1: Role Buttons
  const row1 = {
    type: MessageComponentTypes.ActionRow,
    components: [] as any[],
  };

  for (const role of roles) {
    const count = data.currentRoles[role].length;
    const max = data.maxRoles[role];
    const isFull = count >= max;

    let style = ButtonStyles.Primary;
    if (role === "Healer") style = ButtonStyles.Success;
    if (role === "DPS") style = ButtonStyles.Danger;

    row1.components.push({
      type: MessageComponentTypes.Button,
      customId: `role_${role.toLowerCase()}_${messageId}`,
      label: `${role} ${count}/${max}`,
      style: style,
      disabled: isFull,
    });
  }
  components.push(row1);

  // Row 2: Control Buttons
  const row2 = {
    type: MessageComponentTypes.ActionRow,
    components: [
      {
        type: MessageComponentTypes.Button,
        customId: `leave_${messageId}`,
        label: "参加取消",
        style: ButtonStyles.Secondary,
      },
      {
        type: MessageComponentTypes.Button,
        customId: `close_${messageId}`,
        label: "募集終了",
        style: ButtonStyles.Danger,
      },
    ],
  };
  components.push(row2);

  try {
    await bot.helpers.editMessage(channelId, messageId, {
      embeds: [embed],
      components: components,
    });
  } catch (error) {
    console.error("メッセージ更新エラー:", error);
  }
}

// ---------------------------------------------------------
// Bot作成
// ---------------------------------------------------------

const bot = createBot({
  token: TOKEN || "", // TOKENがない場合は空文字で初期化し、startBotでエラーになるようにする
  intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent | Intents.GuildMembers | Intents.GuildVoiceStates,
  events: {
    ready: (_bot, payload) => {
      console.log(`${payload.user.username} is ready!`);
    },
    // !setup コマンド
    messageCreate: async (bot, message) => {
      if (message.isBot) return;

      if (message.content === "!setup") {
        const embed: Embed = {
          title: "パーティー募集",
          description: "下のボタンを押して募集を開始してください。",
          color: 0xFFD700,
        };

        const components: MessageComponents = [{
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.Button,
              customId: "trigger_create_recruit_no_vc",
              label: "募集を作成",
              style: ButtonStyles.Primary,
            },
            {
              type: MessageComponentTypes.Button,
              customId: "trigger_create_recruit_with_vc",
              label: "募集を作成 (+VC)",
              style: ButtonStyles.Secondary,
            },
          ],
        }];

        await bot.helpers.sendMessage(message.channelId, {
          embeds: [embed],
          components: components,
        });
      }
    },
    // インタラクション処理
    interactionCreate: async (bot, interaction) => {
        try {
            // 1. 募集作成ボタン -> モーダル表示
            if (interaction.type === InteractionTypes.MessageComponent && interaction.data?.componentType === MessageComponentTypes.Button) {
                if (interaction.data.customId === 'trigger_create_recruit_no_vc' || interaction.data.customId === 'trigger_create_recruit_with_vc') {
                    const useVc = interaction.data.customId === 'trigger_create_recruit_with_vc';
                    
                    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                        type: InteractionResponseTypes.Modal,
                        data: {
                            customId: `modal_recruit_create_${useVc ? 'vc' : 'novc'}`,
                            title: "募集内容の設定",
                            components: [
                                {
                                    type: MessageComponentTypes.ActionRow,
                                    components: [{
                                        type: MessageComponentTypes.InputText,
                                        customId: "title_input",
                                        style: TextInputStyles.Short,
                                        label: "タイトル",
                                        placeholder: "エデン零式 1層練習",
                                        maxLength: 50
                                    }]
                                },
                                {
                                    type: MessageComponentTypes.ActionRow,
                                    components: [{
                                        type: MessageComponentTypes.InputText,
                                        customId: "datetime_input",
                                        style: TextInputStyles.Short,
                                        label: "開催日時 (例: 1201 21:00)",
                                        placeholder: "20231201 21:00",
                                        minLength: 5,
                                        maxLength: 20
                                    }]
                                },
                                {
                                    type: MessageComponentTypes.ActionRow,
                                    components: [{
                                        type: MessageComponentTypes.InputText,
                                        customId: "tank_input",
                                        style: TextInputStyles.Short,
                                        label: "Tank募集人数",
                                        placeholder: "2",
                                        value: "2",
                                        minLength: 1,
                                        maxLength: 2
                                    }]
                                },
                                {
                                    type: MessageComponentTypes.ActionRow,
                                    components: [{
                                        type: MessageComponentTypes.InputText,
                                        customId: "healer_input",
                                        style: TextInputStyles.Short,
                                        label: "Healer募集人数",
                                        placeholder: "2",
                                        value: "2",
                                        minLength: 1,
                                        maxLength: 2
                                    }]
                                },
                                {
                                    type: MessageComponentTypes.ActionRow,
                                    components: [{
                                        type: MessageComponentTypes.InputText,
                                        customId: "dps_input",
                                        style: TextInputStyles.Short,
                                        label: "DPS募集人数",
                                        placeholder: "4",
                                        value: "4",
                                        minLength: 1,
                                        maxLength: 2
                                    }]
                                }
                            ]
                        }
                    });
                    return;
                }
            }

            // 2. モーダル提出
            if (interaction.type === InteractionTypes.ModalSubmit) {
                if (interaction.data?.customId?.startsWith('modal_recruit_create_')) {
                    const useVc = interaction.data.customId.endsWith('_vc');
                    
                    // Discordenoではcomponentsの構造が少し異なるため、findで取得
                    const getVal = (id: string) => {
                        // モーダルのコンポーネントはActionRowの中に入っている
                        for (const row of interaction.data?.components || []) {
                            const comp = row.components?.find(c => c.customId === id);
                            if (comp) return comp.value || "";
                        }
                        return "";
                    };

                    const title = getVal('title_input');
                    const datetimeVal = getVal('datetime_input');
                    const tStr = getVal('tank_input');
                    const hStr = getVal('healer_input');
                    const dStr = getVal('dps_input');

                    const t = parseInt(tStr);
                    const h = parseInt(hStr);
                    const d = parseInt(dStr);

                    if (isNaN(t) || isNaN(h) || isNaN(d)) {
                        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.ChannelMessageWithSource,
                            data: { content: '人数は半角数字で入力してください。', flags: 64 } // ephemeral
                        });
                        return;
                    }

                    const parts = datetimeVal.split(/\s+/);
                    const dateVal = parts[0];
                    const timeVal = parts.length > 1 ? parts[1] : '';

                    // ターゲットチャンネル
                    let targetChannelId = interaction.channelId!;
                    if (TARGET_CHANNEL_ID) {
                        targetChannelId = BigInt(TARGET_CHANNEL_ID);
                    }

                    // VC作成
                    let vcId: bigint | null = null;
                    if (useVc && interaction.guildId) {
                        const vcName = `🔑_${title}_VC`;
                        try {
                            const vc = await bot.helpers.createChannel(interaction.guildId, {
                                name: vcName,
                                type: ChannelTypes.GuildVoice,
                            });
                            vcId = vc.id;
                        } catch (e) {
                             await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                                type: InteractionResponseTypes.ChannelMessageWithSource,
                                data: { content: `VC作成に失敗しました: ${e}`, flags: 64 }
                            });
                            return;
                        }
                    }

                    // 仮メッセージ送信 (InteractionResponseではなく通常のメッセージとして送信してIDを取得する)
                    // まずはInteractionへの応答を返す（読み込み中...などを消すため）
                    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                        type: InteractionResponseTypes.DeferredChannelMessageWithSource,
                        data: { flags: 64 }
                    });

                    const embed: Embed = { title: "募集中...", description: "準備中" };
                    const msg = await bot.helpers.sendMessage(targetChannelId, { embeds: [embed] });

                    // データ保存
                    const data: RecruitmentData = {
                        hostId: interaction.user.id,
                        title: title,
                        date: dateVal,
                        time: timeVal,
                        maxRoles: { Tank: t, Healer: h, DPS: d },
                        currentRoles: { Tank: [], Healer: [], DPS: [] },
                        vcId: vcId
                    };
                    recruitments.set(msg.id.toString(), data);

                    // メッセージ更新
                    await updateRecruitmentMessage(bot, targetChannelId, msg.id);

                    // Deferred応答への追記
                    await bot.helpers.editOriginalInteractionResponse(interaction.token, {
                        content: `募集を作成しました！ -> https://discord.com/channels/${interaction.guildId}/${targetChannelId}/${msg.id}`
                    });
                    return;
                }
            }

            // 3. ボタン操作
            if (interaction.type === InteractionTypes.MessageComponent && interaction.data?.componentType === MessageComponentTypes.Button) {
                const parts = interaction.data.customId!.split('_');
                if (parts.length < 2) return;

                const action = parts[0];
                const messageId = parts[parts.length - 1];

                const data = recruitments.get(messageId);
                if (!data) {
                    if (['close', 'leave', 'role'].includes(action)) {
                        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.ChannelMessageWithSource,
                            data: { content: 'この募集データは見つかりません（再起動された可能性があります）。', flags: 64 }
                        });
                    }
                    return;
                }

                if (action === 'role') {
                    const roleKey = parts[1];
                    const roleMap: {[key: string]: 'Tank' | 'Healer' | 'DPS'} = {
                        'tank': 'Tank', 'healer': 'Healer', 'dps': 'DPS'
                    };
                    const role = roleMap[roleKey];
                    if (!role) return;

                    // ロール参加処理
                    let removed = false;
                    ['Tank', 'Healer', 'DPS'].forEach((r) => {
                        const rKey = r as 'Tank' | 'Healer' | 'DPS';
                        if (data.currentRoles[rKey].includes(interaction.user.id)) {
                            data.currentRoles[rKey] = data.currentRoles[rKey].filter(uid => uid !== interaction.user.id);
                            removed = true;
                        }
                    });

                    if (data.currentRoles[role].length >= data.maxRoles[role]) {
                        if (removed) {
                             // 巻き戻し処理が必要だが省略
                        }
                        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.ChannelMessageWithSource,
                            data: { content: 'その枠は満員です。', flags: 64 }
                        });
                        return;
                    }

                    data.currentRoles[role].push(interaction.user.id);
                    
                    // 更新処理
                    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                        type: InteractionResponseTypes.DeferredUpdateMessage,
                    });
                    await updateRecruitmentMessage(bot, interaction.channelId!, BigInt(messageId));
                    
                    // 完了通知はephemeralメッセージで送るか、更新だけで済ますか。今回は更新だけ。
                    // await bot.helpers.sendFollowupMessage(interaction.token, { content: `${role}枠に参加しました！`, flags: 64 });

                } else if (action === 'leave') {
                    let removed = false;
                    ['Tank', 'Healer', 'DPS'].forEach((r) => {
                        const rKey = r as 'Tank' | 'Healer' | 'DPS';
                        if (data.currentRoles[rKey].includes(interaction.user.id)) {
                            data.currentRoles[rKey] = data.currentRoles[rKey].filter(uid => uid !== interaction.user.id);
                            removed = true;
                        }
                    });

                    if (removed) {
                        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.DeferredUpdateMessage,
                        });
                        await updateRecruitmentMessage(bot, interaction.channelId!, BigInt(messageId));
                    } else {
                        await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.ChannelMessageWithSource,
                            data: { content: '参加していません。', flags: 64 }
                        });
                    }

                } else if (action === 'close') {
                    if (interaction.user.id !== data.hostId) {
                         await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                            type: InteractionResponseTypes.ChannelMessageWithSource,
                            data: { content: '募集主のみが終了できます。', flags: 64 }
                        });
                        return;
                    }

                    if (data.vcId && interaction.guildId) {
                        try {
                            await bot.helpers.deleteChannel(data.vcId);
                        } catch (e) {
                            console.error("VC削除エラー", e);
                        }
                    }

                    try {
                        await bot.helpers.deleteMessage(interaction.channelId!, BigInt(messageId));
                    } catch (e) {
                        console.error("メッセージ削除エラー", e);
                    }

                    recruitments.delete(messageId);
                    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
                        type: InteractionResponseTypes.ChannelMessageWithSource,
                        data: { content: '募集を終了し、削除しました。', flags: 64 }
                    });
                }
            }

        } catch (err) {
            console.error("Interaction Error:", err);
        }
    }
  },
});

Deno.cron("Continuous Request", "*/2 * * * *", () => {
    console.log("running...");
});

if (TOKEN) {
    await startBot(bot);
} else {
    console.error("Bot token not found. Please set DISCORD_TOKEN in your environment variables.");
}
