declare const synteeAPI: {
    window: {
        hide: () => Promise<any>;
        minimize: () => Promise<any>;
        show: () => Promise<any>;
        maximizeToggle: () => Promise<any>;
        isMaximized: () => Promise<boolean>;
    };
    settings: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: unknown) => Promise<any>;
        getAll: () => Promise<any>;
        getAutostartStatus: () => Promise<boolean>;
    };
    systemTheme: {
        isDark: () => Promise<boolean>;
        onChange: (cb: (isDark: boolean) => void) => () => Electron.IpcRenderer;
    };
    bgImage: {
        save: (data: Uint8Array, ext: string) => Promise<string | null>;
        list: () => Promise<{
            src: string;
            name: string;
            size: number;
            mtime: number;
        }[]>;
        load: (src: string) => Promise<string | null>;
        delete: (src: string) => Promise<boolean>;
        clear: () => Promise<boolean>;
    };
    sound: {
        save: (data: Uint8Array, ext: string, originalName?: string) => Promise<string | null>;
        list: () => Promise<{
            id: string;
            name: string;
            size: number;
            mtime: number;
        }[]>;
        load: (id: string) => Promise<string | null>;
        delete: (id: string) => Promise<boolean>;
        search: (query: string, page?: number, shortOnly?: boolean) => Promise<{
            results: {
                identifier: string;
                title: string;
                downloads: number;
                size: number;
            }[];
            total: number;
            page: number;
        }>;
        getFiles: (identifier: string) => Promise<{
            files: {
                name: string;
                length: string;
                size: number;
            }[];
            title: string;
        }>;
        fetchPreview: (identifier: string, filename: string) => Promise<string | null>;
        cancelPreview: () => Promise<boolean>;
        saveRemote: (identifier: string, filename: string, title: string) => Promise<string | null>;
    };
    fonts: {
        import: (data: Uint8Array, filename: string) => Promise<string | null>;
        list: () => Promise<{
            id: string;
            name: string;
            size: number;
            mtime: number;
        }[]>;
        read: (id: string) => Promise<string | null>;
        delete: (id: string) => Promise<boolean>;
    };
    auth: {
        login: () => Promise<any>;
        isLoggedIn: () => Promise<boolean>;
        me: () => Promise<any>;
        logout: () => Promise<any>;
        onLoggedIn: (cb: () => void) => () => Electron.IpcRenderer;
        onLoggedOut: (cb: () => void) => () => Electron.IpcRenderer;
        onLoginError: (cb: (err: {
            message: string;
        }) => void) => () => Electron.IpcRenderer;
    };
    profile: {
        update: (payload: {
            display_name?: string | null;
            avatar_url?: string | null;
            username?: string;
        }) => Promise<any>;
        checkUsername: (username: string) => Promise<any>;
        changePassword: (currentPassword: string, newPassword: string) => Promise<any>;
        listApiKeys: () => Promise<any>;
        createApiKey: (name: string) => Promise<any>;
        deleteApiKey: (keyId: string) => Promise<any>;
    };
    gateway: {
        fetchModels: () => Promise<any>;
        fetchModelStatus: () => Promise<any>;
        fetchProviderStatus: () => Promise<any>;
        isAvailable: () => Promise<boolean>;
    };
    billing: {
        balance: () => Promise<any>;
        transactions: (params?: {
            limit?: number;
            offset?: number;
        }) => Promise<any>;
        summary: (params?: {
            hours?: number;
        }) => Promise<any>;
        timeseries: (params?: {
            hours?: number;
        }) => Promise<any>;
        breakdown: (params?: {
            hours?: number;
            by?: "model" | "provider" | "status" | "format";
        }) => Promise<any>;
        plan: () => Promise<any>;
        openTopup: () => Promise<any>;
    };
    stats: {
        overview: (params?: {
            hours?: number;
        }) => Promise<any>;
    };
    messenger: {
        connect: () => Promise<{
            ok: boolean;
        }>;
        disconnect: () => Promise<{
            ok: boolean;
        }>;
        wsSend: (envelope: {
            type: string;
            data: Record<string, unknown>;
        }) => Promise<{
            ok: boolean;
        }>;
        setActive: (conversationId: string | null) => Promise<{
            ok: boolean;
        }>;
        onEvent: (cb: (envelope: {
            type: string;
            data: Record<string, unknown>;
        }) => void) => () => Electron.IpcRenderer;
        friends: {
            list: () => Promise<any>;
            requests: () => Promise<any>;
            search: (username: string) => Promise<any>;
            request: (username: string) => Promise<any>;
            accept: (userId: string) => Promise<any>;
            decline: (userId: string) => Promise<any>;
            unfriend: (userId: string) => Promise<any>;
            block: (userId: string) => Promise<any>;
            unblock: (userId: string) => Promise<any>;
            hide: (userId: string) => Promise<any>;
            unhide: (userId: string) => Promise<any>;
        };
        conversations: {
            list: () => Promise<any>;
            create: (otherId: string) => Promise<any>;
        };
        messages: {
            list: (conversationId: string, cursor?: string | null, limit?: number) => Promise<any>;
            send: (conversationId: string, payload: {
                message_type?: "text" | "code" | "image" | "file";
                body?: string | null;
                attachment_token?: string | null;
                attachment_filename?: string | null;
                attachment_mime?: string | null;
                attachment_size?: number | null;
                reply_to_id?: string | null;
            }) => Promise<any>;
            read: (conversationId: string, messageId: string) => Promise<any>;
            typing: (conversationId: string) => Promise<any>;
            react: (conversationId: string, messageId: string, emoji: string) => Promise<any>;
            delete: (conversationId: string, messageId: string) => Promise<any>;
            search: (q: string, conversationId?: string) => Promise<any>;
        };
        attachments: {
            upload: (file: File) => Promise<any>;
            fetch: (conversationId: string, messageId: string) => Promise<any>;
        };
        shares: {
            shareChat: (chatId: string, recipientId: string) => Promise<{
                ok: true;
                share: unknown;
            } | {
                error: string;
            }>;
            importShare: (shareId: string) => Promise<{
                chatId: string;
                messages: unknown[];
                title: string;
            } | {
                error: string;
            }>;
        };
        global: {
            list: (cursor?: string | null, limit?: number) => Promise<any>;
            send: (payload: {
                message_type?: "text" | "code" | "image" | "file";
                body?: string | null;
                attachment_token?: string | null;
                attachment_filename?: string | null;
                attachment_mime?: string | null;
                attachment_size?: number | null;
                reply_to_id?: string | null;
            }) => Promise<any>;
            read: (messageId: string) => Promise<any>;
            unread: () => Promise<any>;
            react: (messageId: string, emoji: string) => Promise<any>;
            delete: (messageId: string) => Promise<any>;
            typing: () => Promise<any>;
            fetchAttachment: (messageId: string) => Promise<any>;
            shareChat: (chatId: string) => Promise<{
                ok: true;
                message: unknown;
            } | {
                error: string;
            }>;
        };
    };
    system: {
        info: () => Promise<any>;
        logError: (message: string, stack?: string) => Promise<any>;
    };
    overlay: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        getDisplays: () => Promise<any>;
        captureScreen: () => Promise<any>;
        analyze: (params: {
            imageBase64: string;
            prompt: string;
            action: string;
        }) => Promise<any>;
        saveScreenshot: (base64: string) => Promise<any>;
    };
    notification: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        action: (payload: {
            id: string;
            actionId: string;
            type: string;
            chatId?: string;
            reqId?: string;
        }) => void;
        setInteractive: (v: boolean) => void;
        captureScreen: () => Promise<string | null>;
        onPush: (cb: (payload: import("../../shared/types").NotificationPayload) => void) => () => Electron.IpcRenderer;
        onDismissAll: (cb: () => void) => () => Electron.IpcRenderer;
    };
    activity: {
        onStep: (cb: (step: {
            type: string;
            toolName?: string;
            toolArgs?: Record<string, unknown>;
            content?: string;
            success?: boolean;
            msgId?: string;
            callId?: string;
            pendingCallId?: string;
            chatId?: string;
        }) => void) => () => Electron.IpcRenderer;
        onToolProgress: (cb: (data: {
            msgId: string;
            chatId: string;
            toolName: string;
            stage: string;
            detail?: string;
            filesProcessed?: number;
            filesTotal?: number;
        }) => void) => () => Electron.IpcRenderer;
        onRunStatus: (cb: (data: {
            chatId: string;
            status: string;
            msgId?: string;
            error?: string;
        }) => void) => () => Electron.IpcRenderer;
        onHide: (cb: () => void) => () => Electron.IpcRenderer;
        onShow: (cb: () => void) => () => Electron.IpcRenderer;
    };
    spotlight: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        expand: () => Promise<any>;
        collapse: () => Promise<any>;
        quickAsk: (query: string, chatId?: string) => Promise<any>;
        newChat: () => Promise<any>;
        openChat: (chatId: string) => Promise<any>;
        openSettings: (section?: string) => Promise<any>;
        getHistory: () => Promise<string[]>;
        addHistory: (query: string) => Promise<any>;
        clearHistory: () => Promise<any>;
    };
    trayMenu: {
        hide: () => Promise<any>;
        action: (actionId: string) => Promise<any>;
        getMeta: () => Promise<{
            version: string;
        }>;
        getPluginItems: () => Promise<Array<{
            pluginId: string;
            label: string;
            command?: string;
            type: "item" | "separator";
        }>>;
        onPluginItemsChanged: (cb: (items: Array<{
            pluginId: string;
            label: string;
            command?: string;
            type: "item" | "separator";
        }>) => void) => () => Electron.IpcRenderer;
        pluginAction: (pluginId: string, label: string, command?: string) => Promise<any>;
    };
    chat: {
        create: (incognito?: boolean, mode?: "code" | "work", projectId?: string, model?: {
            modelId?: string;
            modelProvider?: string;
            reasoningValue?: string;
        }) => Promise<any>;
        getAll: () => Promise<any>;
        setActive: (chatId: string | null) => Promise<any>;
        getActive: () => Promise<string | null>;
        previewSystemPrompt: (chatId?: string) => Promise<{
            ok: boolean;
            prompt?: string;
            error?: string;
        }>;
        getMessages: (chatId: string) => Promise<any>;
        getMessagesPage: (chatId: string, limit?: number, beforeCreatedAt?: number, beforeId?: string) => Promise<{
            messages: import("../../shared/types").Message[];
            hasMore: boolean;
        }>;
        send: (params: {
            chatId: string;
            content: string;
            displayContent?: string;
            slashCommand?: {
                name: string;
                args: string;
            };
            incognito?: boolean;
            userMsgId?: string;
            planningMode?: boolean;
            askMode?: boolean;
            imageMode?: boolean;
            mode?: "code" | "work";
            /** Single-select persona run mode (classic/architect/debugger/...).
             *  Orthogonal to planning/ask/image toggles. */
            persona?: import("../../shared/modes").PersonaId;
            oneShotSkill?: {
                name: string;
                instructions: string;
            };
            oneShotAllowedTools?: string[];
            oneShotMode?: "ask" | "plan" | "code";
            /** Per-message persona override (/debug, /review, ...). */
            oneShotPersona?: import("../../shared/modes").PersonaId;
            /** Уровень мышления из UI на момент отправки (source of truth для main). */
            reasoningValue?: string;
            attachments?: import("../../shared/types").Attachment[];
            /** Реплай-цитаты: сообщения, на которые отвечает эта отправка. */
            replyTo?: import("../../shared/types").ReplyTarget[];
        }) => Promise<any>;
        delete: (chatId: string) => Promise<any>;
        rename: (chatId: string, title: string) => Promise<any>;
        pin: (messageId: string) => Promise<any>;
        unpin: (messageId: string) => Promise<any>;
        editMessage: (messageId: string, content: string, iterTexts?: string[]) => Promise<boolean>;
        setMessageHidden: (messageId: string, hidden: boolean) => Promise<boolean>;
        deleteMessage: (messageId: string) => Promise<boolean>;
        reloadClient: () => Promise<any>;
        stop: (chatId?: string) => Promise<any>;
        getLiveState: (chatId: string) => Promise<any>;
        archive: (chatId: string, archived: boolean) => Promise<any>;
        pinChat: (chatId: string, pinned: boolean) => Promise<any>;
        setColor: (chatId: string, color: string | null) => Promise<any>;
        duplicate: (chatId: string) => Promise<any>;
        export: (chatId: string, format: "txt" | "md") => Promise<any>;
        getQueue: (chatId: string) => Promise<any>;
        queueRemove: (chatId: string, queueId: string) => Promise<any>;
        queueReorder: (chatId: string, queueIds: string[]) => Promise<any>;
        getSessionTimeline: (chatId: string) => Promise<any>;
        getLastTurnFilesChanged: (chatId: string) => Promise<any>;
        rewindTo: (chatId: string, userMessageId: string) => Promise<any>;
        redo: (chatId: string, rewindMessageId: string) => Promise<any>;
        canRedo: (chatId: string, rewindMessageId: string) => Promise<any>;
        getLastTurnChanges: (chatId: string) => Promise<import("../../shared/types").LastTurnChanges | null>;
        undoLastTurnFiles: (chatId: string) => Promise<{
            restored?: number;
            failed?: string[];
            error?: string;
        }>;
        undoFile: (chatId: string, path: string) => Promise<{
            success?: boolean;
            error?: string;
        }>;
        undoCheckpointFiles: (chatId: string, userMessageId: string) => Promise<{
            restored?: number;
            failed?: string[];
            error?: string;
        }>;
        undoCheckpointFile: (chatId: string, userMessageId: string, path: string) => Promise<{
            success?: boolean;
            error?: string;
        }>;
        getLastRewind: (chatId: string) => Promise<{
            rewindMessageId: string;
            createdAt: number;
        } | null>;
        compact: (chatId: string, mode?: string) => Promise<any>;
        compactCancel: (chatId: string) => Promise<any>;
        fork: (chatId: string, title?: string) => Promise<any>;
        snapshotCreate: (chatId: string, name: string) => Promise<any>;
        snapshotList: (chatId: string) => Promise<any>;
        sideSend: (params: {
            parentChatId: string;
            content: string;
            sideMessages: unknown[];
        }) => Promise<any>;
        searchHistory: (query: string, limit?: number) => Promise<Array<{
            source: "memory" | "messages" | "summaries" | "agent_logs" | "pinned";
            content: string;
            score: number;
            chatId?: string;
            chatTitle?: string;
            messageId?: string;
            role?: string;
            date?: number;
        }>>;
        getModes: (chatId: string) => Promise<{
            planningMode: boolean;
            imageMode: boolean;
            askMode: boolean;
        }>;
        setModes: (chatId: string, modes: {
            planningMode: boolean;
            imageMode: boolean;
            askMode: boolean;
        }) => Promise<any>;
        setPlanningMode: (chatId: string, val: boolean) => Promise<any>;
        setImageMode: (chatId: string, val: boolean) => Promise<any>;
        setAskMode: (chatId: string, val: boolean) => Promise<any>;
        /** Single-select persona run mode (classic/architect/debugger/...). */
        getPersona: (chatId: string) => Promise<import("../../shared/modes").PersonaId>;
        setPersona: (chatId: string, persona: import("../../shared/modes").PersonaId) => Promise<any>;
        /** Per-chat модель: null = глобальное назначение role:'main'. */
        getModel: (chatId: string) => Promise<{
            modelId: string;
            modelProvider: string;
        } | null>;
        setModel: (chatId: string, modelId: string | null, modelProvider: string | null) => Promise<any>;
        /** Per-chat уровень мышления: null = глобальный settings.reasoningValue. */
        getReasoning: (chatId: string) => Promise<string | null>;
        setReasoning: (chatId: string, value: string | null) => Promise<any>;
        getDraft: (chatId: string) => Promise<string>;
        setDraft: (chatId: string, draft: string) => Promise<any>;
        getInputHistory: (chatId: string) => Promise<string[]>;
    };
    projects: {
        pickWorkdir: () => Promise<any>;
        pickNewWorkdir: () => Promise<any>;
        create: (workdir: string) => Promise<any>;
        getAll: () => Promise<any>;
        rename: (id: string, name: string) => Promise<any>;
        delete: (id: string, deleteChats: boolean) => Promise<any>;
        getById: (id: string) => Promise<any>;
        touch: (id: string) => Promise<any>;
        setVerificationCommand: (id: string, command: string | null) => Promise<any>;
        setContextFiles: (id: string, files: string[], autoDiscover: boolean, disabledDiscoveryFiles?: string[]) => Promise<any>;
    };
    fastContext: {
        getStatus: (projectId: string) => Promise<any>;
        reindex: (projectId: string) => Promise<any>;
        clearIndex: (projectId: string) => Promise<any>;
        setActive: (projectId: string | null) => Promise<any>;
        onProgress: (cb: (data: {
            projectId: string;
            stage: string;
            detail?: string;
            filesProcessed?: number;
            filesTotal?: number;
        }) => void) => () => Electron.IpcRenderer;
        onUpdated: (cb: (projectId: string) => void) => () => Electron.IpcRenderer;
    };
    memory: {
        getAll: (filter?: unknown) => Promise<any>;
        save: (entry: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        search: (params: unknown) => Promise<any>;
        pin: (id: string, pinned: boolean) => Promise<any>;
        setImportance: (id: string, importance: number) => Promise<any>;
        stats: () => Promise<any>;
        prune: (maxAgeDays?: number, minImportance?: number) => Promise<any>;
        reindex: () => Promise<any>;
        extractOutcomes: (params?: {
            chatId?: string;
            projectId?: string;
        }) => Promise<any>;
        pruneAgentLogs: (maxAgeDays?: number) => Promise<any>;
        getCategories: (projectId?: string) => Promise<any>;
        createCategory: (input: unknown) => Promise<any>;
        deleteCategory: (id: string) => Promise<any>;
    };
    graph: {
        get: (projectId: string, opts?: unknown) => Promise<any>;
        stats: (projectId: string) => Promise<any>;
        rebuild: (projectId: string) => Promise<any>;
        deleteNode: (id: string) => Promise<any>;
        pinNode: (id: string, pinned: boolean) => Promise<any>;
        pruneIsolated: (projectId?: string) => Promise<any>;
    };
    agent: {
        run: (query: string) => Promise<any>;
        cancel: (id?: string) => Promise<any>;
        list: () => Promise<any>;
        get: (id: string) => Promise<any>;
        children: (parentId: string) => Promise<any>;
        clearChat: (chatId: string) => Promise<any>;
        getSettings: () => Promise<any>;
        setSettings: (s: unknown) => Promise<any>;
        getPermissions: () => Promise<any>;
        setAutoPermissions: (auto: unknown) => Promise<any>;
        getProjectPermissions: (projectId: string) => Promise<any>;
        setProjectPermissions: (projectId: string, override: unknown) => Promise<any>;
        onConfirm: (cb: (data: {
            reqId: string;
            toolName: string;
            args: unknown;
            dangerLevel?: string;
            dangerReason?: string;
            previewDiff?: string;
        }) => void) => (_: unknown, data: unknown) => void;
        offConfirm: (wrapper: (...args: unknown[]) => void) => void;
        confirmResponse: (reqId: string, approved: boolean, always?: "session" | "project" | "global") => void;
        onConfirmDismiss: (cb: (reqId: string) => void) => () => Electron.IpcRenderer;
        onQuestion: (cb: (data: {
            reqId: string;
            questions: unknown[];
            chatId: string;
            msgId: string;
        }) => void) => (_: unknown, data: unknown) => void;
        offQuestion: (wrapper: (...args: unknown[]) => void) => void;
        questionResponse: (reqId: string, answers: unknown[]) => void;
        onQuestionDismiss: (cb: (reqId: string) => void) => () => Electron.IpcRenderer;
    };
    protectedVars: {
        list: () => Promise<import("../shared/types/protectedVars").ProtectedVarMeta[]>;
        save: (input: import("../shared/types/protectedVars").ProtectedVarSaveInput) => Promise<{
            ok: true;
            meta: import("../shared/types/protectedVars").ProtectedVarMeta;
        } | {
            ok: false;
            error: string;
        }>;
        delete: (id: string) => Promise<boolean>;
    };
    providers: {
        getAll: () => Promise<any>;
        save: (provider: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        testKey: (providerId: string) => Promise<any>;
        fetchModels: (providerId: string) => Promise<any>;
    };
    context: {
        estimateInput: (params: {
            text: string;
        }) => Promise<any>;
        calculate: (chatId: string) => Promise<any>;
    };
    models: {
        getAll: () => Promise<any>;
        saveCustom: (model: unknown) => Promise<any>;
        deleteCustom: (modelId: string, providerId: string) => Promise<any>;
        getAssignments: () => Promise<any>;
        setAssignment: (assignment: unknown) => Promise<any>;
        getParams: () => Promise<any>;
        setParams: (params: unknown) => Promise<any>;
        getRecent: () => Promise<any>;
        addRecent: (modelId: string, providerId: string) => Promise<any>;
        getPinned: () => Promise<any>;
        togglePin: (modelId: string, providerId: string) => Promise<any>;
    };
    on: (channel: string, callback: (...args: unknown[]) => void) => () => Electron.IpcRenderer;
    off: (channel: string, _callback: (...args: unknown[]) => void) => void;
    once: (channel: string, callback: (...args: unknown[]) => void) => void;
    debug: {
        streamTest: () => Promise<any>;
        openDevTools: () => Promise<any>;
    };
    image: {
        generate: (params: unknown) => Promise<any>;
        getSettings: () => Promise<any>;
        setSettings: (s: unknown) => Promise<any>;
    };
    shell: {
        openPath: (path: string) => Promise<any>;
        showItemInFolder: (path: string) => Promise<any>;
        getExtensionsPaths: () => Promise<any>;
    };
    pty: {
        detectShells: () => Promise<any>;
        create: (params: {
            chatId: string;
            shell: string;
            cwd?: string;
            source?: "user" | "agent";
            title?: string;
        }) => Promise<any>;
        list: (chatId: string) => Promise<any>;
        write: (sessionId: string, data: string) => Promise<any>;
        resize: (sessionId: string, cols: number, rows: number) => Promise<any>;
        kill: (sessionId: string) => Promise<any>;
        consumePreMount: (sessionId: string) => Promise<any>;
        getMeta: (sessionId: string) => Promise<any>;
    };
    fs: {
        getWorkdir: (chatId: string) => Promise<any>;
        listDirectory: (params: {
            root: string;
            relPath?: string;
            maxEntries?: number;
        }) => Promise<any>;
        readFile: (params: {
            root: string;
            relPath: string;
            maxBytes?: number;
        }) => Promise<any>;
        searchFiles: (params: {
            root: string;
            query: string;
            maxResults?: number;
        }) => Promise<any>;
        writeFile: (params: {
            root: string;
            relPath: string;
            content: string;
        }) => Promise<any>;
        checkFilesExist: (params: {
            root: string;
            relPaths: string[];
        }) => Promise<any>;
        statPath: (absPath: string) => Promise<{
            exists: boolean;
            isDir: boolean;
            isFile: boolean;
            size: number;
            resolved: string;
        }>;
    };
    git: {
        status: (workdir: string) => Promise<any>;
        diff: (params: {
            workdir: string;
            file?: string;
            staged?: boolean;
        }) => Promise<any>;
        show: (params: {
            workdir: string;
            hash: string;
            file?: string;
        }) => Promise<any>;
        log: (params: {
            workdir: string;
            limit?: number;
        }) => Promise<any>;
        branch: (workdir: string) => Promise<any>;
        isRepo: (workdir: string) => Promise<any>;
        add: (params: {
            workdir: string;
            files: string[];
        }) => Promise<any>;
        reset: (params: {
            workdir: string;
            files: string[];
        }) => Promise<any>;
        discard: (params: {
            workdir: string;
            files: string[];
            untracked: boolean;
        }) => Promise<any>;
        diffStat: (params: {
            workdir: string;
            file?: string;
            staged?: boolean;
        }) => Promise<any>;
        commit: (params: {
            workdir: string;
            message: string;
            amend?: boolean;
        }) => Promise<any>;
        push: (params: {
            workdir: string;
            remote?: string;
            branch?: string;
        }) => Promise<any>;
        pull: (params: {
            workdir: string;
            remote?: string;
            branch?: string;
        }) => Promise<any>;
        fetch: (params: {
            workdir: string;
            remote?: string;
        }) => Promise<any>;
        fileVersions: (params: {
            workdir: string;
            file: string;
            ref?: string;
        }) => Promise<any>;
        showFiles: (params: {
            workdir: string;
            hash: string;
        }) => Promise<any>;
        branchList: (workdir: string) => Promise<any>;
        checkout: (params: {
            workdir: string;
            branch: string;
        }) => Promise<any>;
        branchCreate: (params: {
            workdir: string;
            branch: string;
            checkout?: boolean;
        }) => Promise<any>;
        stash: (params: {
            workdir: string;
            message?: string;
        }) => Promise<any>;
        stashPop: (params: {
            workdir: string;
        }) => Promise<any>;
        stashList: (workdir: string) => Promise<any>;
        logFile: (params: {
            workdir: string;
            file: string;
            limit?: number;
        }) => Promise<any>;
    };
    skills: {
        getAll: (params?: {
            projectId?: string;
        }) => Promise<any>;
        setState: (params: {
            skillId: string;
            state: unknown;
            source: "builtin" | "user" | "project";
        }) => Promise<any>;
        reload: () => Promise<any>;
        getActive: (params: {
            chatId: string;
            isIncognito?: boolean;
        }) => Promise<any>;
        installFromUrl: (params: {
            url: string;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
    };
    commands: {
        list: (params?: {
            projectWorkdir?: string;
            chatId?: string;
        }) => Promise<any>;
        reload: () => Promise<any>;
    };
    mcp: {
        getAll: (params?: {
            projectId?: string;
        }) => Promise<any>;
        getActiveForChat: (params: {
            chatId: string;
            isIncognito?: boolean;
        }) => Promise<any>;
        save: (config: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        connect: (serverId: string) => Promise<any>;
        disconnect: (serverId: string) => Promise<any>;
        reconnect: (serverId: string) => Promise<any>;
        setServerState: (params: {
            serverId: string;
            enabled?: boolean;
            scope?: unknown;
        }) => Promise<any>;
        setToolState: (params: {
            serverId: string;
            toolFullName: string;
            state: unknown;
        }) => Promise<any>;
        installDirect: (params: {
            name: string;
            transport: "stdio" | "sse" | "streamable-http";
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            url?: string;
            headers?: Record<string, string>;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
        updateServer: (params: {
            serverId: string;
            env?: Record<string, string>;
            args?: string[];
        }) => Promise<any>;
    };
    plugins: {
        getAll: (params?: {
            projectId?: string;
            chatId?: string;
        }) => Promise<any>;
        checkPython: () => Promise<{
            found: boolean;
            exe?: string;
            version?: string;
        }>;
        installDeps: (params: {
            pluginId: string;
        }) => Promise<{
            ok: boolean;
            error?: string;
            output?: string;
        }>;
        setState: (params: {
            pluginId: string;
            enabled?: boolean;
            scope?: unknown;
            consented?: boolean;
        }) => Promise<any>;
        reload: (pluginId: string) => Promise<any>;
        uninstall: (params: {
            pluginId: string;
            source: "global" | "project";
            dir?: string;
        }) => Promise<any>;
        installFromFolder: (params?: {
            scope?: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
        getPaths: () => Promise<any>;
        executeCommand: (params: {
            chatId: string;
            pluginId: string;
            name: string;
            args: string;
            text: string;
        }) => Promise<any>;
        uiMessage: (params: {
            pluginId: string;
            data: unknown;
        }) => Promise<any>;
        uiCall: (params: {
            pluginId: string;
            method: string;
            args?: Record<string, unknown>;
        }) => Promise<any>;
        beforeSend: (params: {
            chatId: string;
            content: string;
        }) => Promise<any>;
        panelLifecycle: (params: {
            pluginId: string;
            panelId: string;
            action: "opened" | "closed";
        }) => Promise<any>;
        themeChanged: (params: {
            theme: string;
            accentColor: string;
        }) => Promise<any>;
        openDevTools: () => Promise<any>;
        saveReply: (params: {
            chatId: string;
            text: string;
        }) => Promise<any>;
        setConfig: (params: {
            pluginId: string;
            values: Record<string, unknown>;
        }) => Promise<any>;
        search: (params: {
            query: string;
        }) => Promise<Array<{
            pluginId: string;
            providerId: string;
            label: string;
            items: Array<{
                id: string;
                label: string;
                sub?: string;
                icon?: string;
            }>;
        }>>;
        searchClick: (params: {
            pluginId: string;
            providerId: string;
            item: {
                id: string;
                label: string;
                sub?: string;
                icon?: string;
            };
        }) => Promise<any>;
        autocomplete: (params: {
            text: string;
        }) => Promise<{
            pluginId: string;
            trigger: string;
            suggestions: Array<{
                label: string;
                insertText?: string;
                command?: string;
            }>;
        } | null>;
        contextMenuClick: (params: {
            pluginId: string;
            itemId: string;
            payload: {
                messageId: string;
                chatId: string;
                content: string;
                selection?: string;
            };
        }) => Promise<any>;
        notificationAction: (params: {
            pluginId: string;
            command: string;
        }) => Promise<any>;
        inputAction: (params: {
            pluginId: string;
            actionId: string;
        }) => Promise<any>;
        iframeCall: (params: {
            pluginId: string;
            method: string;
            args?: Record<string, unknown>;
        }) => Promise<{
            ok: boolean;
            result?: unknown;
            error?: string;
        }>;
    };
    marketplace: {
        searchMcp: (params: {
            query: string;
            limit?: number;
            cursor?: string;
        }) => Promise<any>;
        cancelMcpSearch: () => Promise<any>;
        searchSkills: (params: {
            query: string;
            page?: number;
            perPage?: number;
        }) => Promise<any>;
        cancelSkillsSearch: () => Promise<any>;
        getSkillReadme: (params: {
            fullName: string;
        }) => Promise<any>;
        buildMcpInstruction: (params: unknown) => Promise<any>;
        buildSkillInstruction: (params: unknown) => Promise<any>;
        buildMcpUrlInstruction: (params: {
            url: string;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
    };
    mentions: {
        search: (params: {
            workdir?: string;
            query: string;
            limit?: number;
            chatId?: string;
        }) => Promise<any>;
        startIndexing: (workdir: string) => Promise<any>;
        stopIndexing: (workdir: string) => Promise<any>;
    };
    attachments: {
        readFile: (params: {
            path: string;
        }) => Promise<any>;
        saveImageFromBase64: (params: {
            chatId: string;
            base64: string;
            mime?: string;
            suggestedName?: string;
        }) => Promise<any>;
        saveFileFromPath: (params: {
            chatId: string;
            sourcePath: string;
        }) => Promise<any>;
        deleteFile: (params: {
            path: string;
        }) => Promise<any>;
        pickFile: () => Promise<any>;
        resolveDropPath: (params: {
            name: string;
            dir?: string;
        }) => Promise<any>;
        repairDraft: (params: {
            chatId: string;
            attachments: unknown[];
        }) => Promise<any>;
        cleanupOrphans: (params: {
            chatId: string;
        }) => Promise<any>;
        getPathForFile: (file: File) => string;
    };
    draft: {
        getAttachments: (chatId: string) => Promise<any>;
        setAttachments: (chatId: string, attachments: import("../../shared/types").Attachment[]) => Promise<any>;
        clearAttachments: (chatId: string) => Promise<any>;
    };
    voice: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        transcribe: (audio: Float32Array, opts?: {
            modelSize?: "tiny" | "base";
        }) => Promise<string>;
        transcribeGroq: (audioData: ArrayBuffer) => Promise<string>;
        status: (modelSize?: string) => Promise<{
            status: string;
            cached: boolean;
            modelSize: string;
            modelId: string;
            displaySize: string;
        }>;
        download: (modelSize?: string) => Promise<{
            ok: boolean;
            error?: string;
        }>;
        onProgress: (cb: (info: {
            stage: string;
            progress?: number;
            message?: string;
        }) => void) => () => Electron.IpcRenderer;
        onStatus: (cb: (info: {
            status: string;
            cached: boolean;
            modelSize: string;
            modelId: string;
            displaySize: string;
        }) => void) => () => Electron.IpcRenderer;
        tts: (text: string) => Promise<string>;
        sendQuery: (text: string) => Promise<void>;
    };
    updates: {
        check: () => Promise<import("../../shared/types").UpdateState>;
        getStatus: () => Promise<import("../../shared/types").UpdateState>;
        getHistory: (params?: {
            channel?: string;
            limit?: number;
        }) => Promise<import("../../shared/types").ChangelogEntry[]>;
        dismiss: (version: string) => Promise<import("../../shared/types").UpdateState>;
        quitAndInstall: () => Promise<import("../../shared/types").QuitAndInstallResult>;
        onStateChanged: (cb: (state: import("../../shared/types").UpdateState) => void) => () => Electron.IpcRenderer;
    };
    clipboard: {
        writeText: (text: string) => Promise<boolean>;
        readText: () => Promise<string>;
    };
    notes: {
        list: (params: {
            scope: "project" | "chat";
            projectId?: string;
            chatId?: string;
        }) => Promise<Array<{
            id: string;
            scope: string;
            projectId: string | null;
            chatId: string | null;
            title: string;
            content: string;
            createdAt: number;
            updatedAt: number;
        }>>;
        getProjectId: (chatId: string) => Promise<string | null>;
        create: (params: {
            scope: "project" | "chat";
            projectId?: string;
            chatId?: string;
            title: string;
            content?: string;
        }) => Promise<{
            success: boolean;
            note?: unknown;
            error?: string;
        }>;
        update: (params: {
            id: string;
            title?: string;
            content?: string;
        }) => Promise<{
            success: boolean;
            note?: unknown;
            error?: string;
        }>;
        delete: (id: string) => Promise<{
            success: boolean;
            error?: string;
        }>;
    };
};
export type SynteeAPI = typeof synteeAPI;
export {};
