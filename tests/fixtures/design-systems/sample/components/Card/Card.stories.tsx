const meta = {
  title: "Components/Card",
  component: "Card",
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
};
