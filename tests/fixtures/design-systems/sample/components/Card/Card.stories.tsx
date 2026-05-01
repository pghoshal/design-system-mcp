const meta = {
  title: "Components/Card",
  component: "Card",
  argTypes: {
    tone: {
      control: "select",
      options: ["neutral", "accent", "danger"],
    },
  },
};

export default meta;

const _HelperStory = {
  args: {
    title: "Internal",
    tone: "neutral",
    children: "Hidden helper",
  },
};

export const NeutralCard = {
  args: {
    title: "Billing",
    tone: "neutral",
    children: "Payment details",
  },
};

export const DangerCard = {
  args: {
    title: "Delete project?",
    tone: "danger",
    children: "This cannot be undone.",
    disabled: true,
  },
  play: async ({ canvasElement }: { canvasElement: { focus: () => void } }) => {
    await canvasElement.focus();
  },
};
