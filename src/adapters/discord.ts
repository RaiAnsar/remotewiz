import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import type { Adapter, AdapterTaskUpdate, ApprovalPrompt, RuntimeConfig } from "../types.js";
import type { RemoteWizApp } from "../app.js";
import { logInfo, logWarn } from "../utils/log.js";

export class DiscordAdapter implements Adapter {
  name = "discord" as const;

  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel],
  });

  private started = false;
  // Track the user's original message per thread for emoji reactions
  private readonly threadMessages = new Map<string, Message>();

  constructor(
    private readonly app: RemoteWizApp,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    this.configureHandlers();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (!this.runtimeConfig.discordToken) {
      logInfo("Discord adapter disabled (DISCORD_TOKEN missing)");
      return;
    }

    await this.client.login(this.runtimeConfig.discordToken);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.client.destroy();
    this.started = false;
  }

  async sendTaskUpdate(update: AdapterTaskUpdate): Promise<void> {
    if (!this.started) {
      return;
    }

    const channel = await this.client.channels.fetch(update.threadId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    // Add emoji reactions to the user's original message
    const userMsg = this.threadMessages.get(update.threadId);
    if (userMsg) {
      try {
        if (update.status === "queued") {
          await userMsg.react("\u{1F552}"); // clock
        } else if (update.status === "running") {
          await userMsg.react("\u{2699}\u{FE0F}"); // gear
          // Show typing indicator while task runs
          if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
            await channel.sendTyping();
          }
        } else if (update.status === "done") {
          await userMsg.react("\u{2705}"); // checkmark
        } else if (update.status === "failed") {
          await userMsg.react("\u{274C}"); // X
        } else if (update.status === "needs_approval") {
          await userMsg.react("\u{26A0}\u{FE0F}"); // warning
        }
      } catch {
        // Reaction may fail if message was deleted or permissions missing
      }
    }

    // Only send text messages for terminal states and approval prompts
    if (update.status === "done" || update.status === "failed" || update.status === "needs_approval") {
      const content = formatTaskUpdate(update);
      await sendLongText(channel, content);

      if (update.status === "done" || update.status === "failed") {
        this.threadMessages.delete(update.threadId);
      }
    }
  }

  async requestApproval(prompt: ApprovalPrompt): Promise<void> {
    if (!this.started) {
      return;
    }

    const channel = await this.client.channels.fetch(prompt.threadId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Approval Required")
      .setDescription(prompt.description)
      .setFooter({ text: `approval:${prompt.approvalId}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${prompt.approvalId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny:${prompt.approvalId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    await sendChannelMessage(channel, { embeds: [embed], components: [row] });
  }

  private configureHandlers(): void {
    this.client.once("ready", async () => {
      logInfo(`Discord adapter ready as ${this.client.user?.tag}`);
      await this.registerCommands();
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isButton()) {
        await this.handleButton(interaction.customId, interaction.user.id, interaction as never);
        return;
      }

      if (interaction.isChatInputCommand()) {
        await this.handleSlash(interaction);
      }
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (!isAllowedUser(this.runtimeConfig, message.author.id)) {
      return;
    }

    // Handle messages inside existing threads
    if (message.channel.isThread()) {
      if (!isAllowedChannel(this.runtimeConfig, message.channel.parentId ?? undefined)) {
        return;
      }
      await this.handleThreadMessage(message);
      return;
    }

    // Handle messages in regular channels (mentions or direct messages)
    if (message.channel.type === ChannelType.GuildText) {
      if (!isAllowedChannel(this.runtimeConfig, message.channel.id)) {
        return;
      }

      // Only respond if the bot is mentioned
      if (!message.mentions.has(this.client.user!)) {
        return;
      }

      // Strip the mention from the prompt
      const prompt = message.content.replace(/<@!?\d+>/g, "").trim();
      if (!prompt) {
        await message.reply("Tag me with a message and I'll create a task thread. Example: `@RemoteWiz fix the login bug`");
        return;
      }

      // Auto-select project: if only one, use it; otherwise ask
      const projects = this.app.getProjects();
      if (projects.length === 0) {
        await message.reply("No projects configured. Add projects with `remotewiz configure`.");
        return;
      }

      let projectAlias: string;
      if (projects.length === 1) {
        projectAlias = projects[0].alias;
      } else {
        // Check if the user prefixed with a project name, e.g. "@Bot desktop: fix the bug"
        const colonMatch = prompt.match(/^(\S+):\s*(.*)/s);
        const spaceMatch = prompt.match(/^(\S+)\s+(.*)/s);
        const matchedProject = colonMatch
          ? projects.find((p) => p.alias === colonMatch[1])
          : undefined;

        if (matchedProject && colonMatch) {
          projectAlias = matchedProject.alias;
          // We'll use the full prompt including project prefix — Claude can handle it
        } else {
          const list = projects.map((p) => `\`${p.alias}\``).join(", ");
          await message.reply(`Multiple projects available: ${list}\nPrefix your message with the project name, e.g. \`@RemoteWiz desktop: fix the bug\``);
          return;
        }
      }

      // Create a thread from this message
      const threadName = `${projectAlias}-${Date.now().toString(36)}`;
      const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
      });

      // Bind thread to project
      this.app.bindThread(thread.id, projectAlias, "discord", message.author.id);
      await thread.send(`Bound to project \`${projectAlias}\`. Processing your task...`);

      // Store reference for emoji reactions
      this.threadMessages.set(thread.id, message);

      try {
        await this.app.enqueueTask({
          projectAlias,
          prompt,
          threadId: thread.id,
          adapter: "discord",
          continueSession: false,
          actorId: message.author.id,
        });
      } catch (error) {
        await thread.send(`Failed to queue task: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      return;
    }
  }

  private async handleThreadMessage(message: Message): Promise<void> {
    if (!message.channel.isThread()) {
      return;
    }

    const threadId = message.channel.id;

    let binding = this.app.getBinding(threadId);
    if (!binding) {
      const autoAlias = message.channel.name.trim();
      const known = this.app.getProjects().find((project) => project.alias === autoAlias);
      if (known) {
        this.app.bindThread(threadId, known.alias, "discord", message.author.id);
        binding = { projectAlias: known.alias };
        await message.channel.send(`Bound this thread to project \`${known.alias}\`.`);
      }
    }

    if (!binding) {
      return;
    }

    // Store reference to user message for emoji reactions
    this.threadMessages.set(threadId, message);

    try {
      await this.app.enqueueTask({
        projectAlias: binding.projectAlias,
        prompt: message.content,
        threadId,
        adapter: "discord",
        continueSession: false,
        actorId: message.author.id,
      });
    } catch (error) {
      await message.channel.send(`Failed to queue task: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isAllowedUser(this.runtimeConfig, interaction.user.id)) {
      await interaction.reply({ content: "Unauthorized.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: false });

    switch (interaction.commandName) {
      case "projects": {
        const list = this.app
          .getProjects()
          .map((project) => `- \`${project.alias}\` → ${project.path}`)
          .join("\n");
        await interaction.editReply(list || "No projects configured.");
        return;
      }
      case "bind": {
        if (!interaction.channel || !interaction.channel.isThread()) {
          await interaction.editReply("Use /bind inside a thread.");
          return;
        }
        const alias = interaction.options.getString("alias", true);
        try {
          this.app.bindThread(interaction.channel.id, alias, "discord", interaction.user.id);
          await interaction.editReply(`Bound thread to \`${alias}\`.`);
        } catch (error) {
          await interaction.editReply(`Bind failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        return;
      }
      case "continue": {
        if (!interaction.channel || !interaction.channel.isThread()) {
          await interaction.editReply("Use /continue inside a thread.");
          return;
        }
        const binding = this.app.getBinding(interaction.channel.id);
        if (!binding) {
          await interaction.editReply("This thread is not bound. Use /bind first.");
          return;
        }
        const prompt = interaction.options.getString("message", true);
        try {
          const result = await this.app.enqueueTask({
            projectAlias: binding.projectAlias,
            prompt,
            threadId: interaction.channel.id,
            adapter: "discord",
            continueSession: true,
            actorId: interaction.user.id,
          });
          await interaction.editReply(`Queued continue task \`${result.taskId}\`.`);
        } catch (error) {
          await interaction.editReply(`Queue failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        return;
      }
      case "status": {
        const status = this.app.getQueueStatus();
        const payload = `Running: ${status.running}\nPending: ${status.pending}\n${JSON.stringify(status.byProject, null, 2)}`;
        await interaction.editReply(clampDiscordText(payload));
        return;
      }
      case "cancel": {
        if (!interaction.channel || !interaction.channel.isThread()) {
          await interaction.editReply("Use /cancel inside a thread.");
          return;
        }
        const tasks = this.app.getThreadTaskHistory(interaction.channel.id, 20);
        const running = tasks.find((task) => task.status === "running" || task.status === "needs_approval");
        if (!running) {
          await interaction.editReply("No running task in this thread.");
          return;
        }
        const canceled = this.app.cancelTask(running.id, interaction.user.id);
        await interaction.editReply(canceled ? `Canceled task \`${running.id}\`.` : "Cancel failed.");
        return;
      }
      case "audit": {
        const project = interaction.options.getString("project") || undefined;
        const limit = interaction.options.getInteger("limit") ?? 20;
        const entries = this.app.getAudit(project, limit) as Array<{ timestamp: number; action: string; taskId?: string }>;
        const text = entries
          .slice(0, limit)
          .map((entry) => `- ${new Date(entry.timestamp).toISOString()} ${entry.action} ${entry.taskId ?? ""}`)
          .join("\n");
        await interaction.editReply(clampDiscordText(text || "No audit entries."));
        return;
      }
      case "budget": {
        const project = interaction.options.getString("project") || undefined;
        const usage = this.app.getBudgetToday(project);
        await interaction.editReply(`Total tokens (24h): ${usage.totalTokens}`);
        return;
      }
      default:
        await interaction.editReply("Unknown command.");
    }
  }

  private async handleButton(customId: string, actorId: string, interaction: {
    deferUpdate(): Promise<unknown>;
    editReply(payload: { content: string; components?: never[] }): Promise<unknown>;
    channel: TextBasedChannel | null;
  }): Promise<void> {
    if (!isAllowedUser(this.runtimeConfig, actorId)) {
      return;
    }

    const [action, approvalId] = customId.split(":");
    if (!action || !approvalId || !["approve", "deny"].includes(action)) {
      return;
    }

    await interaction.deferUpdate();

    const ok = await this.app.resolveApproval(approvalId, actorId, action as "approve" | "deny");
    if (interaction.channel) {
      await sendChannelMessage(
        interaction.channel,
        ok ? `Approval ${action}d: ${approvalId}` : `Approval could not be updated: ${approvalId}`,
      );
    }
  }

  private async registerCommands(): Promise<void> {
    const guildId = this.runtimeConfig.discordGuildId;
    if (!guildId) {
      logWarn("Skipping Discord command registration; DISCORD_GUILD_ID missing");
      return;
    }

    const guild = await this.client.guilds.fetch(guildId);

    const commands = [
      new SlashCommandBuilder().setName("projects").setDescription("List configured projects"),
      new SlashCommandBuilder()
        .setName("bind")
        .setDescription("Bind current thread to project")
        .addStringOption((opt) => opt.setName("alias").setDescription("Project alias").setRequired(true)),
      new SlashCommandBuilder()
        .setName("continue")
        .setDescription("Continue last thread session")
        .addStringOption((opt) => opt.setName("message").setDescription("Prompt").setRequired(true)),
      new SlashCommandBuilder().setName("status").setDescription("Show queue status"),
      new SlashCommandBuilder().setName("cancel").setDescription("Cancel running task in this thread"),
      new SlashCommandBuilder()
        .setName("audit")
        .setDescription("Show audit entries")
        .addStringOption((opt) => opt.setName("project").setDescription("Project alias").setRequired(false))
        .addIntegerOption((opt) => opt.setName("limit").setDescription("Max entries").setRequired(false)),
      new SlashCommandBuilder()
        .setName("budget")
        .setDescription("Show token usage")
        .addStringOption((opt) => opt.setName("project").setDescription("Project alias").setRequired(false)),
    ].map((builder) => builder.toJSON());

    await guild.commands.set(commands);
    logInfo("Discord commands registered");
  }
}

function isAllowedUser(runtimeConfig: RuntimeConfig, userId: string): boolean {
  if (runtimeConfig.discordAllowedUsers.size === 0) {
    return true;
  }
  return runtimeConfig.discordAllowedUsers.has(userId);
}

function isAllowedChannel(runtimeConfig: RuntimeConfig, channelId: string | undefined): boolean {
  if (!channelId) {
    return false;
  }
  if (runtimeConfig.discordChannelIds.size === 0) {
    return true;
  }
  return runtimeConfig.discordChannelIds.has(channelId);
}

function formatTaskUpdate(update: AdapterTaskUpdate): string {
  if (update.status === "running") {
    return `⏳ Task \`${update.taskId}\` is running...`;
  }
  if (update.status === "queued") {
    return `🕒 Task \`${update.taskId}\` queued.`;
  }
  if (update.status === "needs_approval") {
    return `⚠️ Task \`${update.taskId}\` requires approval. ${update.summary ?? ""}`.trim();
  }
  if (update.status === "failed") {
    return `❌ Task \`${update.taskId}\` failed${update.error ? ` (${update.error})` : ""}. ${update.summary ?? ""}`.trim();
  }
  if (update.status === "done") {
    return `✅ Task \`${update.taskId}\` completed.\n\n${update.summary ?? ""}`;
  }
  return `${update.taskId}: ${update.status}`;
}

async function sendChannelMessage(
  channel: unknown,
  payload: string | { content?: string; embeds?: unknown[]; components?: unknown[] },
): Promise<void> {
  if (!channel || typeof channel !== "object") {
    return;
  }
  const maybeSend = (channel as { send?: (value: unknown) => Promise<unknown> }).send;
  if (typeof maybeSend !== "function") {
    return;
  }
  await maybeSend(payload);
}

async function sendLongText(channel: unknown, text: string): Promise<void> {
  const max = 1900;
  if (text.length <= max) {
    await sendChannelMessage(channel, { content: text });
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, max));
    remaining = remaining.slice(max);
  }

  for (const chunk of chunks) {
    await sendChannelMessage(channel, { content: chunk });
  }
}

function clampDiscordText(input: string): string {
  const max = 1900;
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 32)}\n\n[truncated for Discord limit]`;
}
